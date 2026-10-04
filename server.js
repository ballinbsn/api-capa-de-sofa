const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const QRCode = require("qrcode");
const { Pool } = require("pg");
const { createStore } = require("./db");

const {
  ADEX_PUBLIC_KEY,
  ADEX_SECRET_KEY,
  ADEX_WEBHOOK_SECRET,
  ALLOWED_ORIGINS = "http://localhost:5577,http://127.0.0.1:5577",
  PUBLIC_API_URL = "",
  ADEX_AMOUNT_UNIT = "reais",
  UTMIFY_API_TOKEN,
  UTMIFY_TEST,
  MOCK_ADEX,
  DATABASE_URL,
  DATABASE_SSL,
  GOOGLE_ADS_FEED_TOKEN,
  PORT = 3000,
} = process.env;

/* Banco (Railway Postgres). Sem DATABASE_URL a API segue só em memória. */
const store = createStore(
  global.__TEST_DB__ || // só nos testes automatizados (test/*.test.js)
    (DATABASE_URL
      ? new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false, max: 5 })
      : null)
);

const ADEX_BASE = "https://api.adex.cash/functions/v1";
const MOCK = MOCK_ADEX === "true";

/* Oferta fixa no servidor: o navegador nunca decide preço.
   Kit "Leve 2 Pague 1": 2 capas de sofá (cores escolhidas) + 2 almofadas inclusas.
   O preço do kit depende só do tamanho. */
const PRODUCT_NAME = "Capa de Sofá em Algodão";
const SIZES = {
  2: { label: "2 Assentos", cents: 8790 },
  3: { label: "3 Assentos", cents: 8790 },
  4: { label: "4 Assentos", cents: 9790 },
  5: { label: "5 Assentos", cents: 10790 },
};
const COLORS = {
  cinza: "Cinza",
  vermelho: "Vermelho",
  marrom: "Marrom",
};
const MAX_QTY = 5;

const kitTitle = (k) => `${PRODUCT_NAME} ${k.sizeLabel} - 1ª capa ${k.color1Label}, 2ª capa ${k.color2Label} + 2 almofadas`;
const kitTotalCents = (k) => k.unitCents * k.quantity;

if (!MOCK && (!ADEX_PUBLIC_KEY || !ADEX_SECRET_KEY)) {
  console.error("Faltam ADEX_PUBLIC_KEY / ADEX_SECRET_KEY. Defina as variáveis de ambiente.");
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1);

/* ALLOWED_ORIGINS: domínios do site separados por vírgula, ou "*" para aceitar qualquer
   site (o dono pediu para não amarrar a um domínio; o preço é sempre definido aqui). */
const allowedOrigins = ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
const anyOrigin = allowedOrigins.includes("*");
app.use(
  cors({
    origin: (origin, cb) => cb(null, anyOrigin || !origin || allowedOrigins.includes(origin)),
    methods: ["GET", "POST"],
  })
);
app.use(
  express.json({
    limit: "20kb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

/* ---------------- Limite de requisições por IP (em memória) ---------------- */

function rateLimit(max, windowMs) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
    if (n > max) return res.status(429).json({ error: "Muitas tentativas. Aguarde um pouco." });
    next();
  };
}

/* ---------------- Validação ---------------- */

const digits = (v) => String(v || "").replace(/\D/g, "");

function validCpf(raw) {
  const cpf = digits(raw);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (let t = 9; t < 11; t++) {
    let sum = 0;
    for (let i = 0; i < t; i++) sum += Number(cpf[i]) * (t + 1 - i);
    const dv = ((sum * 10) % 11) % 10;
    if (dv !== Number(cpf[t])) return false;
  }
  return true;
}

function validateOrder(body) {
  const c = (body && body.customer) || {};
  const a = c.address || {};
  const errors = [];

  const name = String(c.name || "").trim();
  if (name.split(/\s+/).length < 2 || name.length < 5) errors.push("Informe nome e sobrenome.");
  const email = String(c.email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.push("E-mail inválido.");
  const phone = digits(c.phone);
  if (phone.length < 10 || phone.length > 11) errors.push("Telefone inválido (use DDD).");
  if (!validCpf(c.cpf)) errors.push("CPF inválido.");

  const zip = digits(a.zip);
  if (zip.length !== 8) errors.push("CEP inválido.");
  ["street", "number", "neighborhood", "city"].forEach((f) => {
    if (!String(a[f] || "").trim()) errors.push("Endereço incompleto.");
  });
  if (!/^[A-Za-z]{2}$/.test(String(a.state || ""))) errors.push("UF inválida.");

  const k = (body && body.kit) || {};
  const size = SIZES[Number(k.size)];
  const quantity = Number(k.quantity);
  if (!size || !COLORS[k.color1] || !COLORS[k.color2]) errors.push("Escolha o tamanho e as cores das capas.");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) errors.push("Quantidade inválida.");

  if (errors.length) return { errors: [...new Set(errors)] };

  return {
    order: {
      name,
      email,
      phone,
      cpf: digits(c.cpf),
      address: {
        zip,
        street: String(a.street).trim(),
        number: String(a.number).trim(),
        complement: String(a.complement || "").trim(),
        neighborhood: String(a.neighborhood).trim(),
        city: String(a.city).trim(),
        state: String(a.state).toUpperCase(),
      },
      kit: {
        size: Number(k.size),
        sizeLabel: size.label,
        color1: k.color1,
        color1Label: COLORS[k.color1],
        color2: k.color2,
        color2Label: COLORS[k.color2],
        quantity,
        unitCents: size.cents,
      },
    },
  };
}

/* ---------------- ADEX ---------------- */

const adexHeaders = () => ({
  "x-public-key": ADEX_PUBLIC_KEY,
  "x-secret-key": ADEX_SECRET_KEY,
  "Content-Type": "application/json",
});

const money = (cents) => (ADEX_AMOUNT_UNIT === "cents" ? cents : cents / 100);

const mockCharges = new Map();

async function createCharge(order) {
  if (MOCK) {
    const id = crypto.randomUUID();
    mockCharges.set(id, Date.now());
    return {
      id,
      qrCode: "00020126580014br.gov.bcb.pix0136MOCK-" + id + "520400005303986540" + (kitTotalCents(order.kit) / 100).toFixed(2) + "5802BR5909CAPA-MOCK6009SAO PAULO62070503***6304ABCD",
      expirationDate: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
  }

  const payload = {
    amount: money(kitTotalCents(order.kit)),
    paymentMethod: "pix",
    customer: {
      name: order.name,
      email: order.email,
      phone: order.phone,
      document: { number: order.cpf, type: "cpf" },
      address: order.address,
    },
    items: [
      {
        title: kitTitle(order.kit),
        unitPrice: money(order.kit.unitCents),
        quantity: order.kit.quantity,
        tangible: true,
      },
    ],
    pix: { expirationDate: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
  };
  if (PUBLIC_API_URL) payload.postbackUrl = PUBLIC_API_URL.replace(/\/$/, "") + "/api/webhook";

  const res = await fetch(ADEX_BASE + "/pix-receive", {
    method: "POST",
    headers: adexHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.pix || !data.pix.qrCode) {
    console.error("ADEX pix-receive falhou", res.status, JSON.stringify(data));
    throw new Error("adex_create_failed");
  }
  console.log("ADEX pix-receive resposta (formato)", JSON.stringify(shape(data)));
  const tx = data.transaction || {};
  const id = data.id || data.transaction_id || data.transactionId || tx.id || tx.transaction_id;
  if (!id) {
    console.error("ADEX pix-receive sem id de transação");
    throw new Error("adex_create_failed");
  }
  const fee = Number(tx.fee_amount) || 0;
  return {
    id,
    qrCode: data.pix.qrCode,
    expirationDate: data.pix.expirationDate || payload.pix.expirationDate,
    feeCents: Math.round(ADEX_AMOUNT_UNIT === "cents" ? fee : fee * 100),
  };
}

/* Mostra só a estrutura da resposta (tipos) e valores curtos de campos seguros,
   sem dados pessoais nem o código Pix. Útil para conferir o formato da ADEX. */
function shape(v, key = "") {
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => shape(x, key));
  if (v && typeof v === "object") {
    const out = {};
    Object.keys(v).forEach((k) => (out[k] = shape(v[k], k)));
    return out;
  }
  const safe = /(^id$|_id$|Id$|status|amount|type|expiration|expires|currency)/.test(key);
  if (typeof v === "string") return safe && v.length <= 60 ? v : `<string ${v.length}>`;
  return safe ? v : `<${typeof v}>`;
}

async function fetchStatus(id) {
  if (MOCK) {
    const created = mockCharges.get(id);
    if (!created) return "expired";
    return Date.now() - created > 20000 ? "paid" : "pending";
  }
  const res = await fetch(`${ADEX_BASE}/pix-receive?transaction_id=${encodeURIComponent(id)}`, {
    headers: adexHeaders(),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.transaction) {
    console.error("ADEX status falhou", res.status, JSON.stringify(data));
    throw new Error("adex_status_failed");
  }
  return data.transaction.status;
}

/* ---------------- Rotas ---------------- */

app.get("/health", (_req, res) => res.json({ ok: true, db: store.enabled() ? "ok" : "off" }));

app.post("/api/pix", rateLimit(10, 10 * 60 * 1000), async (req, res) => {
  const { order, errors } = validateOrder(req.body);
  if (errors) return res.status(422).json({ error: errors.join(" ") });

  try {
    const charge = await createCharge(order);
    const qrImage = await QRCode.toDataURL(charge.qrCode, { margin: 1, width: 300 });
    const tracking = sanitizeTracking(req.body.tracking);
    console.log(
      JSON.stringify({
        evt: "pix_created",
        transaction_id: charge.id,
        kit: `${kitTitle(order.kit)} x${order.kit.quantity}`,
        tracking,
      })
    );
    const createdAt = new Date();
    trackedOrders.set(charge.id, {
      createdAt,
      order,
      tracking,
      ip: req.ip,
      feeCents: charge.feeCents || 0,
    });
    /* Grava o pedido antes de responder: é o que permite reconhecer o webhook depois e
       ligar a venda ao clique do Google mesmo que o cliente feche a página. */
    try {
      await store.insertOrder({
        transactionId: charge.id,
        createdAt,
        amountCents: kitTotalCents(order.kit),
        feeCents: charge.feeCents || 0,
        currency: "BRL",
        kit: order.kit,
        customer: { name: order.name, email: order.email, phone: order.phone, cpf: order.cpf },
        ip: req.ip,
        tracking,
      });
    } catch (err) {
      console.error(JSON.stringify({ evt: "db_erro", etapa: "insert_order", transaction_id: charge.id, erro: err.message }));
    }
    sendUtmify(charge.id, "waiting_payment");
    res.json({
      transactionId: charge.id,
      qrCode: charge.qrCode,
      qrImage,
      expirationDate: charge.expirationDate,
      amount: kitTotalCents(order.kit) / 100,
    });
  } catch {
    res.status(502).json({ error: "Não foi possível gerar o Pix agora. Tente novamente em instantes." });
  }
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.get("/api/pix/:id/status", rateLimit(200, 10 * 60 * 1000), async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: "ID inválido." });
  try {
    const status = await fetchStatus(req.params.id);
    if (status === "paid") await handlePaid(req.params.id, new Date(), "status");
    res.json({ status });
  } catch {
    res.status(502).json({ error: "Falha ao consultar o pagamento." });
  }
});

function validSignature(req) {
  const header = String(req.headers["x-webhook-signature"] || "").replace("sha256=", "");
  if (!header || !ADEX_WEBHOOK_SECRET) return false;
  const candidates = [req.rawBody, Buffer.from(JSON.stringify(req.body))];
  return candidates.some((buf) => {
    const expected = crypto.createHmac("sha256", ADEX_WEBHOOK_SECRET).update(buf).digest("hex");
    return (
      header.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected))
    );
  });
}

/* Pedido criado por esta API? (banco; se o banco estiver fora, a memória do processo).
   A conta da ADEX manda para este webhook pagamentos de OUTRAS ofertas: esses não são
   vendas desta loja e não podem ir para a UTMify nem virar conversão no Google Ads. */
async function isOurOrder(id) {
  if (trackedOrders.has(id)) return true;
  try {
    return !!(await store.getOrder(id));
  } catch (err) {
    console.error(JSON.stringify({ evt: "db_erro", etapa: "get_order", transaction_id: id, erro: err.message }));
    return false;
  }
}

/* Pagamento confirmado (webhook charge.paid ou consulta de status). Idempotente:
   grava paid_at uma vez só; a UTMify recebe "paid" uma vez só. */
async function handlePaid(id, paidAt, origem) {
  if (!(await isOurOrder(id))) return false;
  let first = null;
  try {
    first = await store.markPaid(id, paidAt);
  } catch (err) {
    console.error(JSON.stringify({ evt: "db_erro", etapa: "mark_paid", transaction_id: id, erro: err.message }));
  }
  const mem = trackedOrders.get(id);
  if (mem && !mem.approvedAt) mem.approvedAt = paidAt;
  if (first) console.log(JSON.stringify({ evt: "venda_paga", transaction_id: id, origem, paid_at: paidAt.toISOString() }));
  await sendUtmify(id, "paid");
  return true;
}

app.post("/api/webhook", async (req, res) => {
  if (ADEX_WEBHOOK_SECRET && !validSignature(req)) {
    return res.status(401).json({ error: "Assinatura inválida" });
  }
  const { event, data } = req.body || {};
  const txId = data && (data.transaction_id || data.id || (data.transaction && data.transaction.id));
  const ours = txId ? await isOurOrder(String(txId)) : false;
  console.log(
    JSON.stringify({
      evt: ours ? "webhook" : "webhook_ignorado",
      motivo: ours ? undefined : "pedido nao criado por esta API (outra oferta da conta ADEX)",
      event,
      transaction_id: txId,
      status: data && data.status,
      amount: data && data.amount,
    })
  );
  if (!ours) return res.status(200).json({ received: true, ignored: true });

  const id = String(txId);
  const ts = req.body.timestamp && !Number.isNaN(Date.parse(req.body.timestamp)) ? new Date(req.body.timestamp) : new Date();
  const kind =
    { "charge.paid": "paid", "charge.refunded": "refunded", "charge.chargeback": "chargedback", "charge.failed": "refused" }[event] ||
    { paid: "paid", refunded: "refunded" }[data && data.status];
  try {
    if (kind === "paid") await handlePaid(id, ts, "webhook");
    else if (kind === "refunded" || kind === "chargedback") {
      try {
        await store.markRefunded(id, kind, ts);
      } catch (err) {
        console.error(JSON.stringify({ evt: "db_erro", etapa: "mark_refunded", transaction_id: id, erro: err.message }));
      }
      const mem = trackedOrders.get(id);
      if (mem && !mem.refundedAt) mem.refundedAt = ts;
      await sendUtmify(id, kind);
    } else if (kind === "refused") await sendUtmify(id, kind);
  } catch (err) {
    console.error(JSON.stringify({ evt: "webhook_erro", transaction_id: id, erro: err.message }));
  }
  res.status(200).json({ received: true });
});

/* ---------------- UTMify ----------------
   Envia o pedido à UTMify (POST /api-credentials/orders): "waiting_payment" ao gerar o
   Pix e "paid" quando a ADEX confirma (webhook ou consulta de status — o que vier
   primeiro; cada status é enviado uma vez). O token fica só nesta variável de ambiente.
   Os pedidos ficam em memória até a confirmação; se o servidor reiniciar nesse meio
   tempo, a venda paga daquele pedido não é reenviada. */

const trackedOrders = new Map();
const utmifySent = new Set();
setInterval(() => {
  const limit = Date.now() - 48 * 60 * 60 * 1000;
  trackedOrders.forEach((o, id) => {
    if (o.createdAt.getTime() < limit) {
      trackedOrders.delete(id);
      utmifySent.delete(id + ":waiting_payment");
      utmifySent.delete(id + ":paid");
    }
  });
}, 60 * 60 * 1000).unref();

const utcStamp = (d) => d.toISOString().slice(0, 19).replace("T", " ");

/* Pedido a partir do banco (servidor reiniciou entre o Pix e o pagamento). */
function orderFromRow(row) {
  return {
    createdAt: new Date(row.created_at),
    approvedAt: row.paid_at ? new Date(row.paid_at) : null,
    refundedAt: row.refunded_at ? new Date(row.refunded_at) : null,
    order: Object.assign({}, row.customer || {}, { kit: row.kit || null, totalCents: row.amount_cents }),
    tracking: {
      src: row.src, sck: row.sck, utm_source: row.utm_source, utm_campaign: row.utm_campaign,
      utm_medium: row.utm_medium, utm_content: row.utm_content, utm_term: row.utm_term,
    },
    ip: row.ip,
    feeCents: row.fee_cents || 0,
  };
}

async function loadOrder(id) {
  let o = trackedOrders.get(id);
  if (o) return o;
  try {
    const row = await store.getOrder(id);
    if (row) {
      o = orderFromRow(row);
      trackedOrders.set(id, o);
    }
  } catch (err) {
    console.error(JSON.stringify({ evt: "db_erro", etapa: "load_order", transaction_id: id, erro: err.message }));
  }
  return o || null;
}

/* Reserva o envio (banco quando disponível; senão memória). true = pode enviar. */
async function claimUtmify(id, status) {
  try {
    const r = await store.claimUtmify(id, status);
    if (r !== null) return r;
  } catch (err) {
    console.error(JSON.stringify({ evt: "db_erro", etapa: "claim_utmify", transaction_id: id, erro: err.message }));
  }
  const key = id + ":" + status;
  if (utmifySent.has(key)) return false;
  utmifySent.add(key);
  return true;
}

async function releaseUtmify(id, status) {
  utmifySent.delete(id + ":" + status);
  try {
    await store.releaseUtmify(id, status);
  } catch (err) {
    console.error(JSON.stringify({ evt: "db_erro", etapa: "release_utmify", transaction_id: id, erro: err.message }));
  }
}

async function sendUtmify(id, status) {
  if (!UTMIFY_API_TOKEN) return;
  const o = await loadOrder(id);
  if (!o) return; // só pedidos desta loja
  if (!o.ip) {
    /* A UTMify exige o IP do comprador. Não inventamos um: o envio é pulado e registrado. */
    console.log(JSON.stringify({ evt: "utmify_pulado", transaction_id: id, status, motivo: "pedido sem IP do comprador" }));
    return;
  }
  if (!(await claimUtmify(id, status))) return;
  if (status === "paid" && !o.approvedAt) o.approvedAt = new Date();
  if ((status === "refunded" || status === "chargedback") && !o.refundedAt) o.refundedAt = new Date();
  if (o.refundedAt && !o.approvedAt) o.approvedAt = o.createdAt;

  const t = o.tracking || {};
  const kit = o.order.kit;
  const totalCents = kit ? kitTotalCents(kit) : o.order.totalCents || 0;
  /* Venda só conta de verdade na UTMify com UTMIFY_TEST=false. O prefixo da chave da ADEX
     não serve para isso: a chave de teste dela não começa com pk_test_. */
  const isTest = UTMIFY_TEST !== "false";
  const body = {
    orderId: id,
    platform: "LunaLarCheckout",
    paymentMethod: "pix",
    status,
    createdAt: utcStamp(o.createdAt),
    approvedDate: o.approvedAt ? utcStamp(o.approvedAt) : null,
    refundedAt: o.refundedAt ? utcStamp(o.refundedAt) : null,
    customer: {
      name: o.order.name,
      email: o.order.email,
      phone: o.order.phone,
      document: o.order.cpf,
      country: "BR",
      ip: o.ip,
    },
    products: kit
      ? [
          {
            id: `capa-sofa-${kit.size}-${kit.color1}-${kit.color2}`,
            name: kitTitle(kit),
            planId: null,
            planName: null,
            quantity: kit.quantity,
            priceInCents: kit.unitCents,
          },
        ]
      : [
          {
            id: "capa-sofa-kit",
            name: `${PRODUCT_NAME} - kit 2 capas + 2 almofadas`,
            planId: null,
            planName: null,
            quantity: 1,
            priceInCents: totalCents,
          },
        ],
    trackingParameters: {
      src: t.src || null,
      sck: t.sck || null,
      utm_source: t.utm_source || null,
      utm_campaign: t.utm_campaign || null,
      utm_medium: t.utm_medium || null,
      utm_content: t.utm_content || null,
      utm_term: t.utm_term || null,
    },
    commission: {
      totalPriceInCents: totalCents,
      gatewayFeeInCents: o.feeCents,
      userCommissionInCents: totalCents - o.feeCents,
    },
    isTest,
  };

  try {
    const res = await fetch("https://api.utmify.com.br/api-credentials/orders", {
      method: "POST",
      headers: { "x-api-token": UTMIFY_API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text().catch(() => "");
    console.log(
      JSON.stringify({ evt: "utmify", transaction_id: id, status, isTest, http: res.status, resposta: text.slice(0, 300) })
    );
    if (!res.ok) await releaseUtmify(id, status);
  } catch (err) {
    await releaseUtmify(id, status);
    console.error("UTMify falhou", id, status, err && err.message);
  }
}

/* Identificadores de clique do Google: só caracteres que eles usam de fato. */
const CLICK_ID = /^[A-Za-z0-9_\-.]{10,512}$/;

function sanitizeTracking(t) {
  const keys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "src", "sck", "fbclid", "ttclid"];
  const out = {};
  keys.forEach((k) => {
    if (t && typeof t[k] === "string" && t[k]) out[k] = t[k].slice(0, 200);
  });
  ["gclid", "gbraid", "wbraid"].forEach((k) => {
    if (t && typeof t[k] === "string" && CLICK_ID.test(t[k])) out[k] = t[k];
  });
  return out;
}

/* ---------------- Google Ads: arquivo de conversões (Data Manager / importação programada) ----------------
   Lista as vendas PAGAS desta loja (confirmadas pela ADEX) que têm gclid/gbraid/wbraid,
   dos últimos 90 dias. O Google Ads lê este arquivo por HTTPS em horário programado.
   Sem dados pessoais. O Google descarta repetições (mesma ação + data/hora + identificador)
   e o Order ID impede contar a mesma venda duas vezes. Protegido por um token longo na URL
   (variável GOOGLE_ADS_FEED_TOKEN, mínimo 32 caracteres); sem ele a rota não existe. */

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function googleAdsCsv(rows) {
  const header = ["order_id", "gclid", "gbraid", "wbraid", "conversion_time", "conversion_value", "currency"];
  const lines = rows.map((r) =>
    [
      r.transaction_id,
      r.gclid,
      r.gbraid,
      r.wbraid,
      new Date(r.paid_at).toISOString().replace(/\.\d{3}Z$/, "Z"),
      (r.amount_cents / 100).toFixed(2),
      r.currency || "BRL",
    ]
      .map(csvCell)
      .join(",")
  );
  return [header.join(","), ...lines].join("\n") + "\n";
}

function feedTokenOk(given) {
  if (!GOOGLE_ADS_FEED_TOKEN || GOOGLE_ADS_FEED_TOKEN.length < 32) return false;
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(GOOGLE_ADS_FEED_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get("/api/google-ads/conversoes/:token.csv", rateLimit(60, 60 * 60 * 1000), async (req, res) => {
  if (!feedTokenOk(req.params.token) || !store.enabled()) return res.status(404).end();
  try {
    const rows = await store.googleAdsConversions(90);
    await store.markServed(rows.map((r) => r.transaction_id));
    console.log(JSON.stringify({ evt: "google_ads_arquivo_lido", linhas: rows.length, ua: String(req.headers["user-agent"] || "").slice(0, 80) }));
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Cache-Control", "no-store");
    res.send(googleAdsCsv(rows));
  } catch (err) {
    console.error(JSON.stringify({ evt: "db_erro", etapa: "google_ads_arquivo", erro: err.message }));
    res.status(500).end();
  }
});

async function start() {
  try {
    if (await store.init()) console.log(JSON.stringify({ evt: "db_pronto" }));
    else console.log(JSON.stringify({ evt: "db_desligado", motivo: "DATABASE_URL não definida (só memória)" }));
  } catch (err) {
    console.error(JSON.stringify({ evt: "db_erro", etapa: "init", erro: err.message }));
  }
  return app.listen(PORT, () => console.log(`api-capa-de-sofa na porta ${PORT}${MOCK ? " (MOCK)" : ""}`));
}

if (require.main === module) start();

module.exports = { app, store, start, googleAdsCsv, sanitizeTracking, trackedOrders };
