const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const QRCode = require("qrcode");

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
  PORT = 3000,
} = process.env;

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

app.get("/health", (_req, res) => res.json({ ok: true }));

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
    trackedOrders.set(charge.id, {
      createdAt: new Date(),
      order,
      tracking,
      ip: req.ip,
      feeCents: charge.feeCents || 0,
    });
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
    if (status === "paid") sendUtmify(req.params.id, "paid");
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

app.post("/api/webhook", (req, res) => {
  if (ADEX_WEBHOOK_SECRET && !validSignature(req)) {
    return res.status(401).json({ error: "Assinatura inválida" });
  }
  const { event, data } = req.body || {};
  console.log(
    JSON.stringify({
      evt: "webhook",
      event,
      transaction_id: data && data.transaction_id,
      status: data && data.status,
      amount: data && data.amount,
    })
  );
  const txId = data && (data.transaction_id || data.id || (data.transaction && data.transaction.id));
  const utmifyStatus =
    { "charge.paid": "paid", "charge.refunded": "refunded", "charge.chargeback": "chargedback", "charge.failed": "refused" }[event] ||
    { paid: "paid", refunded: "refunded" }[data && data.status];
  if (txId && utmifyStatus) sendUtmify(txId, utmifyStatus, orderFromWebhook(data, req.body.timestamp));
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

/* Pedido reconstruído a partir do webhook da ADEX, para o caso do servidor ter
   reiniciado entre a geração do Pix e o pagamento (pedido não está mais em memória). */
function orderFromWebhook(data, timestamp) {
  const fee = Number(data.fee_amount) || 0;
  const amount = Number(data.amount) || 0;
  const t = timestamp && !Number.isNaN(Date.parse(timestamp)) ? new Date(timestamp) : new Date();
  return {
    createdAt: t,
    order: {
      name: data.customer_name || "Cliente",
      email: data.customer_email || "cliente@example.com",
      phone: data.customer_phone || "",
      cpf: data.customer_document || "",
      kit: null,
      totalCents: ADEX_AMOUNT_UNIT === "cents" ? Math.round(amount) : Math.round(amount * 100),
    },
    tracking: {},
    ip: null,
    feeCents: Number.isInteger(fee) && fee > 100 ? fee : Math.round(fee * 100),
  };
}

async function sendUtmify(id, status, fallbackOrder) {
  if (!UTMIFY_API_TOKEN) return;
  let o = trackedOrders.get(id);
  if (!o && fallbackOrder) {
    o = fallbackOrder;
    trackedOrders.set(id, o);
  }
  const key = id + ":" + status;
  if (!o || utmifySent.has(key)) return;
  utmifySent.add(key);
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
    if (!res.ok) utmifySent.delete(key);
  } catch (err) {
    utmifySent.delete(key);
    console.error("UTMify falhou", id, status, err && err.message);
  }
}

function sanitizeTracking(t) {
  const keys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "src", "sck", "fbclid", "gclid", "ttclid"];
  const out = {};
  keys.forEach((k) => {
    if (t && typeof t[k] === "string") out[k] = t[k].slice(0, 200);
  });
  return out;
}

app.listen(PORT, () => console.log(`api-capa-de-sofa na porta ${PORT}${MOCK ? " (MOCK)" : ""}`));
