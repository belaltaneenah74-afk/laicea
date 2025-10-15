// server.js — FINAL
// Node 18+ recommended. Works on Render free tier.
// Features: CORS (multi origins), HTTPS keep-alive, PayPal token cache, robust errors.

import express from "express";
import cors from "cors";
import helmet from "helmet";
import https from "https";
import fetch from "node-fetch"; // if Node 18+, you can remove this import and use global fetch

const app = express();

// ───────── Security & JSON ─────────
app.use(helmet());
app.use(express.json({ limit: "1mb" }));

// ───────── CORS (multiple origins or *) ─────────
// ALLOWED_ORIGIN can be: "*"  OR  "https://a.com,https://b.com,https://c.myshopify.com"
const rawAllowed = process.env.ALLOWED_ORIGIN || "*";
const allowedList =
  rawAllowed === "*"
    ? "*"
    : rawAllowed
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);

app.use(
  cors({
    origin:
      allowedList === "*"
        ? true
        : (origin, cb) => {
            // allow server-to-server & tools without Origin header
            if (!origin) return cb(null, true);
            if (allowedList.includes(origin)) return cb(null, true);
            return cb(new Error(`CORS blocked for origin: ${origin}`));
          },
    credentials: false,
  })
);

// ───────── Env ─────────
const {
  // PayPal
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_ENV = "live", // "live" | "sandbox"

  // Shopify
  SHOPIFY_STORE = "iptcy7-up", // e.g. "yourstore"
  SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_API_VERSION = "2025-10", // keep in sync with your store capabilities

  // Server
  PORT = 3000,
} = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.warn("⚠️ Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET");
}
if (!SHOPIFY_STORE || !SHOPIFY_ADMIN_TOKEN) {
  console.warn("⚠️ Missing SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN");
}

const PP_BASE =
  PAYPAL_ENV === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";

const SHOP_ADMIN = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

// ───────── Networking (keep-alive) ─────────
const httpsAgent = new https.Agent({ keepAlive: true });

// ───────── Utils ─────────
const toVariantGID = (id) => `gid://shopify/ProductVariant/${id}`;

function logError(tag, err, extra = {}) {
  const safe = {
    message: err?.message || String(err),
    stack: err?.stack ? String(err.stack).split("\n").slice(0, 3).join(" | ") : undefined,
    ...extra,
  };
  console.error(`❌ ${tag}:`, safe);
}

function sendErr(res, code, msg, details) {
  return res.status(code).json({ ok: false, error: msg, details });
}

// ───────── PayPal Access Token Cache ─────────
let ppTokenCache = { token: null, exp: 0 };

async function paypalAccessToken() {
  const now = Date.now();
  if (ppTokenCache.token && now < ppTokenCache.exp - 30_000) {
    return ppTokenCache.token;
  }
  const res = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    agent: httpsAgent,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `PayPal OAuth failed: ${res.status} ${JSON.stringify(data)}`
    );
  }
  const ttlMs = ((data.expires_in || 900) * 1000); // usually ~9000s, safeguard 900s
  ppTokenCache = { token: data.access_token, exp: Date.now() + ttlMs };
  return data.access_token;
}

// ───────── Shopify GraphQL helper ─────────
async function shopifyGraphQL(query, variables = {}) {
  const r = await fetch(SHOP_ADMIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
    agent: httpsAgent,
  });
  const j = await r.json();
  if (!r.ok || j.errors) {
    throw new Error("Shopify GraphQL error: " + JSON.stringify(j.errors || j));
  }
  return j.data;
}

// ───────── Routes: PayPal ─────────

// 1) Generate client token (for JS SDK if needed)
app.post("/api/paypal/client-token", async (_req, res) => {
  try {
    const token = await paypalAccessToken();
    const r = await fetch(`${PP_BASE}/v1/identity/generate-token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      agent: httpsAgent,
    });
    const j = await r.json();
    if (!r.ok || !j?.client_token) {
      return sendErr(res, 400, "Failed to generate client token", j);
    }
    res.json({ ok: true, client_token: j.client_token });
  } catch (e) {
    logError("client-token", e);
    return sendErr(res, 500, e.message);
  }
});

// 2) Create order (used for Hosted Fields; for PayPal Buttons you may use actions.order.create)
app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const { value, currency = "USD" } = req.body || {};
    if (!value) return sendErr(res, 400, "Missing amount value");

    const token = await paypalAccessToken();
    const r = await fetch(`${PP_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: {
              currency_code: currency,
              value: String(value),
            },
          },
        ],
      }),
      agent: httpsAgent,
    });
    const j = await r.json();
    if (!r.ok || !j?.id) {
      return sendErr(res, r.status || 400, "PayPal create order failed", j);
    }
    res.json({ ok: true, orderID: j.id });
  } catch (e) {
    logError("create-order", e, { body: req.body });
    return sendErr(res, 500, e.message);
  }
});

// 3) Capture order (after approval or HF submit)
app.post("/api/paypal/capture", async (req, res) => {
  try {
    const { paypalOrderId } = req.body || {};
    if (!paypalOrderId) return sendErr(res, 400, "Missing paypalOrderId");

    const token = await paypalAccessToken();
    const capRes = await fetch(`${PP_BASE}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      agent: httpsAgent,
    });
    const cap = await capRes.json();
    if (!capRes.ok) {
      return sendErr(res, 400, "PayPal capture failed", cap);
    }

    const status =
      cap?.status || cap?.purchase_units?.[0]?.payments?.captures?.[0]?.status;
    if (status !== "COMPLETED") {
      return sendErr(res, 400, `Unexpected PayPal status: ${status || "unknown"}`, cap);
    }

    const pu = cap?.purchase_units?.[0] || {};
    const ship = pu?.shipping?.address || {};
    const fullName = pu?.shipping?.name?.full_name || "";
    const payer = cap?.payer || {};
    const fallbackFull = `${payer?.name?.given_name || ""} ${payer?.name?.surname || ""}`.trim();
    const nameToUse = (fullName || fallbackFull).trim();

    let given_name = "", surname = "";
    if (nameToUse) {
      const parts = nameToUse.split(" ");
      given_name = parts.shift() || "";
      surname = parts.join(" ");
    }

    const address = {
      firstName: given_name || payer?.name?.given_name || "",
      lastName: surname || payer?.name?.surname || "",
      address1: ship?.address_line_1 || "",
      city: ship?.admin_area_2 || "",
      zip: ship?.postal_code || "",
      country: ship?.country_code || "",
      phone: "",
      email: payer?.email_address || "",
    };

    const captureId =
      pu?.payments?.captures?.[0]?.id ||
      pu?.payments?.authorizations?.[0]?.id ||
      cap?.id;

    res.json({ ok: true, captureId, address, raw: cap });
  } catch (e) {
    logError("capture", e, { body: req.body });
    return sendErr(res, 500, e.message);
  }
});

// ───────── Routes: Shopify (DraftOrder → Complete) ─────────
app.post("/api/shopify/order-from-paypal", async (req, res) => {
  try {
    const b = req.body || {};
    const errs = [];

    // expected: line_items: [{ variant_id, quantity, price? }], address{}, shipping_label, shipping_price
    if (!Array.isArray(b.line_items) || b.line_items.length === 0)
      errs.push("line_items is required");

    const A = b.address || {};
    ["firstName", "lastName", "address1", "city", "zip", "country"].forEach((k) => {
      if (!A[k]) errs.push(`address.${k} is required`);
    });

    if (b.shipping_label == null) errs.push("shipping_label is required");
    if (b.shipping_price == null) errs.push("shipping_price is required");

    if (errs.length) return sendErr(res, 400, "Invalid payload", errs);

    // Build DraftOrderInput
    const draftInput = {
      email: A.email || undefined,
      billingAddress: {
        firstName: A.firstName,
        lastName: A.lastName,
        address1: A.address1,
        city: A.city,
        zip: A.zip,
        country: A.country,
        phone: A.phone || null,
      },
      shippingAddress: {
        firstName: A.firstName,
        lastName: A.lastName,
        address1: A.address1,
        city: A.city,
        zip: A.zip,
        country: A.country,
        phone: A.phone || null,
      },
      lineItems: b.line_items.map((li) => ({
        variantId: toVariantGID(li.variant_id),
        quantity: parseInt(li.quantity, 10),
        // price is optional. If provided, must be string decimal.
        ...(li.price ? { price: String(li.price) } : {}),
      })),
      shippingLine:
        b.shipping_price !== "" && b.shipping_price != null
          ? { title: b.shipping_label || "Shipping", price: String(b.shipping_price) }
          : null,
      note: `PayPal order: ${b.paypalOrderId || ""} | capture: ${b.paypalCaptureId || ""}`.trim(),
    };

    const draftOrderCreate = `
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id }
          userErrors { field message }
        }
      }
    `;

    const createRes = await shopifyGraphQL(draftOrderCreate, { input: draftInput });
    const ue1 = createRes?.draftOrderCreate?.userErrors || [];
    if (ue1.length) return sendErr(res, 400, "Shopify userErrors (create)", ue1);

    const draftId = createRes?.draftOrderCreate?.draftOrder?.id;
    if (!draftId) return sendErr(res, 400, "Failed to create draft order", createRes);

    const draftOrderComplete = `
      mutation draftOrderComplete($id: ID!) {
        draftOrderComplete(id: $id) {
          draftOrder { id order { id name } }
          userErrors { field message }
        }
      }
    `;

    const completeRes = await shopifyGraphQL(draftOrderComplete, { id: draftId });
    const ue2 = completeRes?.draftOrderComplete?.userErrors || [];
    if (ue2.length) return sendErr(res, 400, "Shopify userErrors (complete)", ue2);

    const orderNode = completeRes?.draftOrderComplete?.draftOrder?.order;
    if (!orderNode?.id) return sendErr(res, 400, "Unable to complete draft order", completeRes);

    res.json({ ok: true, order: orderNode });
  } catch (e) {
    logError("order-from-paypal", e, { body: req.body });
    return sendErr(res, 500, e.message);
  }
});

// ───────── Health ─────────
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ───────── Start ─────────
app.listen(PORT, () => {
  console.log(`✅ API listening on :${PORT}`);
  console.log(`   Allowed origins: ${rawAllowed}`);
  console.log(`   Shopify: ${SHOPIFY_STORE}.myshopify.com / v${SHOPIFY_API_VERSION}`);
  console.log(`   PayPal: ${PAYPAL_ENV} (${PP_BASE})`);
});
