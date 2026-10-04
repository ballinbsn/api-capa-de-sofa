/* Persistência dos pedidos (PostgreSQL no Railway, variável DATABASE_URL).
   Guarda, por transação da ADEX: identificadores de clique do Google (gclid/gbraid/wbraid),
   UTMs, valor, moeda, datas, status e o que já foi enviado (UTMify / Google Ads).
   Sem DATABASE_URL a API continua funcionando só em memória (como antes), e o
   arquivo de conversões do Google Ads fica desligado. */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  transaction_id   TEXT PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at          TIMESTAMPTZ,
  refunded_at      TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'pending',
  amount_cents     INTEGER NOT NULL,
  fee_cents        INTEGER NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'BRL',
  kit              JSONB,
  customer         JSONB,
  ip               TEXT,
  gclid            TEXT,
  gbraid           TEXT,
  wbraid           TEXT,
  utm_source       TEXT,
  utm_medium       TEXT,
  utm_campaign     TEXT,
  utm_content      TEXT,
  utm_term         TEXT,
  src              TEXT,
  sck              TEXT,
  fbclid           TEXT,
  ttclid           TEXT,
  utmify_sent      TEXT[] NOT NULL DEFAULT '{}',
  gads_first_served_at TIMESTAMPTZ,
  gads_last_served_at  TIMESTAMPTZ,
  gads_hold        BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS orders_paid_at_idx ON orders (paid_at);
`;

const TRACK_COLS = ["gclid", "gbraid", "wbraid", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "src", "sck", "fbclid", "ttclid"];

function createStore(pool) {
  let ready = false;

  async function init() {
    if (!pool) return false;
    await pool.query(SCHEMA);
    ready = true;
    return true;
  }

  const enabled = () => !!pool && ready;

  async function insertOrder(o) {
    if (!enabled()) return false;
    const t = o.tracking || {};
    const cols = ["transaction_id", "created_at", "status", "amount_cents", "fee_cents", "currency", "kit", "customer", "ip", ...TRACK_COLS];
    const vals = [
      o.transactionId,
      o.createdAt,
      "pending",
      o.amountCents,
      o.feeCents || 0,
      o.currency || "BRL",
      JSON.stringify(o.kit || null),
      JSON.stringify(o.customer || null),
      o.ip || null,
      ...TRACK_COLS.map((k) => t[k] || null),
    ];
    const ph = vals.map((_, i) => `$${i + 1}`).join(",");
    await pool.query(`INSERT INTO orders (${cols.join(",")}) VALUES (${ph}) ON CONFLICT (transaction_id) DO NOTHING`, vals);
    return true;
  }

  async function getOrder(id) {
    if (!enabled()) return null;
    const r = await pool.query("SELECT * FROM orders WHERE transaction_id = $1", [id]);
    return r.rows[0] || null;
  }

  /* Marca como pago uma única vez. Devolve true só na primeira vez (idempotente). */
  async function markPaid(id, paidAt) {
    if (!enabled()) return null;
    const r = await pool.query(
      "UPDATE orders SET status = 'paid', paid_at = $2 WHERE transaction_id = $1 AND paid_at IS NULL RETURNING transaction_id",
      [id, paidAt]
    );
    return r.rowCount === 1;
  }

  async function markRefunded(id, status, at) {
    if (!enabled()) return null;
    const r = await pool.query(
      "UPDATE orders SET status = $2, refunded_at = COALESCE(refunded_at, $3) WHERE transaction_id = $1 AND status <> $2 RETURNING transaction_id",
      [id, status, at]
    );
    return r.rowCount === 1;
  }

  /* Reserva o envio de um status à UTMify. true = este processo deve enviar (ninguém enviou antes). */
  async function claimUtmify(id, status) {
    if (!enabled()) return null;
    const r = await pool.query(
      "UPDATE orders SET utmify_sent = array_append(utmify_sent, $2) WHERE transaction_id = $1 AND NOT ($2 = ANY(utmify_sent)) RETURNING transaction_id",
      [id, status]
    );
    return r.rowCount === 1;
  }

  async function releaseUtmify(id, status) {
    if (!enabled()) return;
    await pool.query("UPDATE orders SET utmify_sent = array_remove(utmify_sent, $2) WHERE transaction_id = $1", [id, status]);
  }

  /* Vendas pagas desta loja com identificador de clique do Google, últimos `days` dias. */
  async function googleAdsConversions(days) {
    if (!enabled()) return [];
    const r = await pool.query(
      `SELECT transaction_id, gclid, gbraid, wbraid, paid_at, amount_cents, currency
         FROM orders
        WHERE status = 'paid' AND paid_at IS NOT NULL AND gads_hold = false
          AND paid_at >= now() - ($1 || ' days')::interval
          AND (gclid IS NOT NULL OR gbraid IS NOT NULL OR wbraid IS NOT NULL)
        ORDER BY paid_at`,
      [String(days)]
    );
    return r.rows;
  }

  async function markServed(ids) {
    if (!enabled() || !ids.length) return;
    await pool.query(
      "UPDATE orders SET gads_first_served_at = COALESCE(gads_first_served_at, now()), gads_last_served_at = now() WHERE transaction_id = ANY($1)",
      [ids]
    );
  }

  return { init, enabled, insertOrder, getOrder, markPaid, markRefunded, claimUtmify, releaseUtmify, googleAdsConversions, markServed };
}

module.exports = { createStore, SCHEMA, TRACK_COLS };
