/* Testes do fluxo de pedido → pagamento → UTMify → arquivo do Google Ads.
   Rodam com PostgreSQL real em memória (PGlite) e ADEX simulada (MOCK_ADEX=true).
   Nada sai para a internet: a chamada à UTMify é interceptada. */
const test = require("node:test");
const assert = require("node:assert/strict");

const FEED_TOKEN = "t".repeat(16) + "0123456789abcdef0123"; // 36 caracteres
process.env.MOCK_ADEX = "true";
process.env.UTMIFY_API_TOKEN = "token-de-teste";
process.env.UTMIFY_TEST = "true";
process.env.GOOGLE_ADS_FEED_TOKEN = FEED_TOKEN;
process.env.PORT = "0";
delete process.env.ADEX_WEBHOOK_SECRET;
delete process.env.DATABASE_URL;

const realFetch = global.fetch;
const utmifyCalls = [];
global.fetch = async (url, opts) => {
  if (String(url).startsWith("https://api.utmify.com.br/")) {
    utmifyCalls.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ OK: true }), { status: 200 });
  }
  return realFetch(url, opts);
};

let base, server, mod, db;

const GCLID = "CjwKCAjwTESTE_gclid-0123456789abcdefABCDEF";
const GBRAID = "0AAAAATESTEgbraid0123456789";

const customer = {
  name: "Maria Teste",
  email: "maria@example.com",
  phone: "11987654321",
  cpf: "52998224725",
  address: { zip: "01310100", street: "Av Paulista", number: "1000", neighborhood: "Bela Vista", city: "São Paulo", state: "SP" },
};

async function post(path, body) {
  const r = await realFetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function createPix(kit, tracking) {
  const r = await post("/api/pix", { customer, kit, tracking });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.transactionId;
}

const paidWebhook = (id, amount, ts) => ({ event: "charge.paid", data: { transaction_id: id, status: "paid", amount }, timestamp: ts });

test.before(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite();
  db = pg;
  global.__TEST_DB__ = {
    query: async (sql, params) => {
      if (!params || !params.length) {
        if (sql.split(";").filter((s) => s.trim()).length > 1) {
          await pg.exec(sql);
          return { rows: [], rowCount: 0 };
        }
      }
      const r = await pg.query(sql, params || []);
      return { rows: r.rows, rowCount: r.affectedRows !== undefined ? r.affectedRows : r.rows.length };
    },
  };
  mod = require("../server.js");
  server = await mod.start();
  await new Promise((ok) => server.listening ? ok() : server.once("listening", ok));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test("health mostra banco ligado", async () => {
  const r = await realFetch(base + "/health").then((x) => x.json());
  assert.deepEqual(r, { ok: true, db: "ok" });
});

test("gclid/gbraid/wbraid válidos são guardados; inválidos são descartados", () => {
  const t = mod.sanitizeTracking({ gclid: GCLID, gbraid: GBRAID, wbraid: "x<script>", utm_source: "google", foo: "bar" });
  assert.equal(t.gclid, GCLID);
  assert.equal(t.gbraid, GBRAID);
  assert.equal(t.wbraid, undefined);
  assert.equal(t.utm_source, "google");
  assert.equal(t.foo, undefined);
});

test("criar Pix grava o pedido com clique do Google, UTMs, valor e moeda (status pendente)", async () => {
  const id = await createPix({ size: 4, color1: "cinza", color2: "vermelho", quantity: 1 }, {
    gclid: GCLID, utm_source: "google", utm_campaign: "24303805376", utm_medium: "206297645448", utm_content: "826411283931", utm_term: "::",
  });
  const row = (await db.query("SELECT * FROM orders WHERE transaction_id = $1", [id])).rows[0];
  assert.ok(row, "pedido gravado");
  assert.equal(row.status, "pending");
  assert.equal(row.paid_at, null);
  assert.equal(row.amount_cents, 9790);
  assert.equal(row.currency, "BRL");
  assert.equal(row.gclid, GCLID);
  assert.equal(row.utm_campaign, "24303805376");
  assert.ok(row.ip, "IP do comprador guardado (a UTMify exige)");
  assert.ok(utmifyCalls.some((c) => c.orderId === id && c.status === "waiting_payment"));
  // Pix pendente NÃO aparece no arquivo do Google Ads
  const csv = await realFetch(`${base}/api/google-ads/conversoes/${FEED_TOKEN}.csv`).then((x) => x.text());
  assert.ok(!csv.includes(id), "pendente não vira conversão");
});

test("webhook de outra oferta (R$147, pedido desconhecido) é ignorado: sem banco, sem UTMify", async () => {
  const before = utmifyCalls.length;
  const r = await post("/api/webhook", paidWebhook("a06d9bf1-a664-4e24-ac0f-ad0702ae939c", 147, "2026-10-03T11:13:35Z"));
  assert.equal(r.status, 200);
  assert.equal(r.body.ignored, true);
  assert.equal(utmifyCalls.length, before);
  const n = (await db.query("SELECT count(*)::int AS n FROM orders WHERE transaction_id = $1", ["a06d9bf1-a664-4e24-ac0f-ad0702ae939c"])).rows[0].n;
  assert.equal(n, 0);
});

test("charge.paid marca a venda uma vez só; webhook repetido não duplica UTMify nem muda a data", async () => {
  const id = await createPix({ size: 3, color1: "marrom", color2: "marrom", quantity: 1 }, { gclid: GCLID, utm_source: "google" });
  const ts = "2026-10-04T15:21:30Z";
  for (let i = 0; i < 3; i++) assert.equal((await post("/api/webhook", paidWebhook(id, 87.9, ts))).status, 200);
  // repetição com outro horário também não muda a data do pagamento
  await post("/api/webhook", paidWebhook(id, 87.9, "2026-10-04T18:00:00Z"));
  const row = (await db.query("SELECT * FROM orders WHERE transaction_id = $1", [id])).rows[0];
  assert.equal(row.status, "paid");
  assert.equal(new Date(row.paid_at).toISOString(), "2026-10-04T15:21:30.000Z");
  const paidCalls = utmifyCalls.filter((c) => c.orderId === id && c.status === "paid");
  assert.equal(paidCalls.length, 1, "UTMify recebe 'paid' uma vez só");
  assert.equal(paidCalls[0].commission.totalPriceInCents, 8790);
  assert.equal(paidCalls[0].trackingParameters.utm_source, "google");
});

test("servidor reiniciado (memória vazia): webhook ainda é reconhecido pelo banco e a UTMify recebe os dados certos", async () => {
  const id = await createPix({ size: 5, color1: "cinza", color2: "cinza", quantity: 2 }, { gbraid: GBRAID, utm_source: "google", utm_campaign: "24303805376" });
  mod.trackedOrders.clear(); // simula reinício
  await post("/api/webhook", paidWebhook(id, 215.8, "2026-10-04T16:00:00Z"));
  const paidCalls = utmifyCalls.filter((c) => c.orderId === id && c.status === "paid");
  assert.equal(paidCalls.length, 1);
  assert.equal(paidCalls[0].commission.totalPriceInCents, 21580);
  assert.equal(paidCalls[0].trackingParameters.utm_campaign, "24303805376");
  assert.ok(paidCalls[0].customer.ip, "IP vem do banco, não é inventado");
});

test("arquivo do Google Ads: só vendas pagas com clique Google, valor, BRL, Order ID e horário UTC", async () => {
  const semClique = await createPix({ size: 2, color1: "vermelho", color2: "vermelho", quantity: 1 }, { utm_source: "google" });
  await post("/api/webhook", paidWebhook(semClique, 87.9, "2026-10-04T17:00:00Z"));

  const r = await realFetch(`${base}/api/google-ads/conversoes/${FEED_TOKEN}.csv`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/csv/);
  const lines = (await r.text()).trim().split("\n");
  assert.equal(lines[0], "order_id,gclid,gbraid,wbraid,conversion_time,conversion_value,currency");
  const rows = lines.slice(1).map((l) => l.split(","));
  assert.equal(rows.length, 2, "as 2 vendas pagas com gclid/gbraid; sem a venda sem clique e sem as pendentes");
  const porValor = Object.fromEntries(rows.map((c) => [c[5], c]));
  assert.deepEqual(porValor["87.90"].slice(1), [GCLID, "", "", "2026-10-04T15:21:30Z", "87.90", "BRL"]);
  assert.deepEqual(porValor["215.80"].slice(1), ["", GBRAID, "", "2026-10-04T16:00:00Z", "215.80", "BRL"]);
  assert.ok(!lines.join("\n").includes(semClique));
  assert.ok(!/@|52998224725|Maria/.test(lines.join("\n")), "sem dados pessoais no arquivo");
  const served = (await db.query("SELECT count(*)::int AS n FROM orders WHERE gads_first_served_at IS NOT NULL")).rows[0].n;
  assert.equal(served, 2, "registro de que a conversão foi entregue ao Google");
});

test("arquivo do Google Ads exige o token certo", async () => {
  assert.equal((await realFetch(`${base}/api/google-ads/conversoes/errado.csv`)).status, 404);
  assert.equal((await realFetch(`${base}/api/google-ads/conversoes/${"x".repeat(36)}.csv`)).status, 404);
});

test("arquivo do Google Ads por usuário e senha (Data Manager / HTTP Basic)", async () => {
  const url = `${base}/api/google-ads/conversoes.csv`;
  const auth = (u, p) => ({ headers: { Authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") } });
  const sem = await realFetch(url);
  assert.equal(sem.status, 401);
  assert.match(sem.headers.get("www-authenticate"), /^Basic/);
  assert.equal((await realFetch(url, auth("googleads", "errada"))).status, 401);
  assert.equal((await realFetch(url, auth("outro", FEED_TOKEN))).status, 401);
  const ok = await realFetch(url, auth("googleads", FEED_TOKEN));
  assert.equal(ok.status, 200);
  const csv = await ok.text();
  assert.ok(csv.startsWith("order_id,gclid,gbraid,wbraid,conversion_time,conversion_value,currency\n"));
  assert.equal(csv.trim().split("\n").length, 3, "cabeçalho + 2 vendas pagas com clique");
});

test("arquivo do Google Ads manda um identificador de clique por venda (gclid > gbraid > wbraid)", () => {
  const base = { paid_at: "2026-10-06T17:13:54Z", amount_cents: 8790, currency: "BRL" };
  const csv = mod.googleAdsCsv([
    { ...base, transaction_id: "a", gclid: "G1234567890", gbraid: "B1234567890", wbraid: null },
    { ...base, transaction_id: "b", gclid: null, gbraid: "B1234567890", wbraid: "W1234567890" },
    { ...base, transaction_id: "c", gclid: null, gbraid: null, wbraid: "W1234567890" },
  ]).trim().split("\n").slice(1);
  assert.deepEqual(csv.map((l) => l.split(",").slice(0, 4)), [
    ["a", "G1234567890", "", ""],
    ["b", "", "B1234567890", ""],
    ["c", "", "", "W1234567890"],
  ]);
});

test("CSV escapa vírgulas e aspas", () => {
  const csv = mod.googleAdsCsv([{ transaction_id: 'a,"b"', gclid: null, gbraid: null, wbraid: null, paid_at: "2026-10-04T00:00:00Z", amount_cents: 100, currency: "BRL" }]);
  assert.ok(csv.includes('"a,""b"""'));
});
