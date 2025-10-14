// server.js
// Backend for Shopify + PayPal (Capture) with multi-origin CORS
// Node >= 18 (أو استخدم node-fetch كما هنا)

import express from "express";
import cors from "cors";
import helmet from "helmet";
import fetch from "node-fetch";

const app = express();

// ───────────── Middlewares ─────────────
app.use(helmet());
app.use(express.json({ limit: "1mb" }));

// ───────────── Env Vars ─────────────
// ملاحظة: لا تضع أسرار داخل الكود. كل شيء من الـ .env / Render env.
const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_ENV = "live", // live | sandbox
  SHOPIFY_STORE,       // مثال: "laicea" بدون .myshopify.com
  SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_API_VERSION = "2025-10",
  ALLOWED_ORIGIN = "*" // أمثلة: "https://www.laicea.com,https://laicea.com,https://XXXX.myshopify.com"
} = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.warn("⚠️ Missing PayPal credentials (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)");
}
if (!SHOPIFY_STORE || !SHOPIFY_ADMIN_TOKEN) {
  console.warn("⚠️ Missing Shopify credentials (SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN)");
}

// PayPal base URL
const PP_BASE =
  PAYPAL_ENV === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";

// Shopify Admin GraphQL endpoint
const SHOP_ADMIN = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

// ───────────── CORS (متعدد الدومينات) ─────────────
const ORIGINS =
  ALLOWED_ORIGIN === "*"
    ? "*"
    : ALLOWED_ORIGIN.split(",").map(s => s.trim()).filter(Boolean);

const corsOptions =
  ORIGINS === "*"
    ? { origin: true }
    : {
        origin: (origin, cb) => {
          // السماح لطلبات السيرفر نفسه (fetch بدون origin) أو أي دومين ضمن القائمة
          if (!origin || ORIGINS.includes(origin)) return cb(null, true);
          return cb(new Error("Not allowed by CORS: " + origin));
        },
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"]
      };

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // preflight

// ───────────── Helpers ─────────────
async function paypalAccessToken() {
  const res = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString(
          "base64"
        ),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `PayPal OAuth failed: ${res.status} ${JSON.stringify(data)}`
    );
  }
  return data.access_token;
}

async function shopifyGraphQL(query, variables = {}) {
  const r = await fetch(SHOP_ADMIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (!r.ok || j.errors) {
    throw new Error("Shopify GraphQL error: " + JSON.stringify(j.errors || j));
  }
  return j.data;
}

const toVariantGID = id => `gid://shopify/ProductVariant/${id}`;

// ───────────── Routes ─────────────

// 1) Generate PayPal client token (لـ Hosted Fields أو wallet gated)
app.post("/api/paypal/client-token", async (_req, res) => {
  try {
    const access = await paypalAccessToken();
    const r = await fetch(`${PP_BASE}/v1/identity/generate-token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json"
      }
    });
    const j = await r.json();
    if (!r.ok || !j?.client_token) {
      return res
        .status(400)
        .json({ ok: false, error: "Failed to generate client token", details: j });
    }
    res.json({ ok: true, client_token: j.client_token });
  } catch (e) {
    console.error("❌ /client-token:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 2) Create PayPal Order (لما تستخدم Hosted Fields)
app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const { value, currency = "USD" } = req.body || {};
    if (!value) return res.status(400).json({ ok: false, error: "Missing amount value" });

    const access = await paypalAccessToken();
    const r = await fetch(`${PP_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: currency, value: value } }]
      })
    });
    const j = await r.json();
    if (!r.ok) {
      return res
        .status(r.status)
        .json({ ok: false, error: "PayPal create order failed", details: j });
    }
    res.json({ ok: true, orderID: j.id });
  } catch (e) {
    console.error("❌ /create-order:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 3) Capture PayPal Order (لـ buttons أو بعد Hosted Fields submit)
app.post("/api/paypal/capture", async (req, res) => {
  try {
    const { paypalOrderId } = req.body || {};
    if (!paypalOrderId)
      return res.status(400).json({ ok: false, error: "Missing paypalOrderId" });

    const access = await paypalAccessToken();
    const capRes = await fetch(
      `${PP_BASE}/v2/checkout/orders/${paypalOrderId}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access}`,
          "Content-Type": "application/json"
        }
      }
    );
    const cap = await capRes.json();
    if (!capRes.ok) {
      return res
        .status(400)
        .json({ ok: false, error: "PayPal capture failed", details: cap });
    }

    const status =
      cap?.status ||
      cap?.purchase_units?.[0]?.payments?.captures?.[0]?.status;
    if (status !== "COMPLETED") {
      return res.status(400).json({
        ok: false,
        error: `Unexpected PayPal status: ${status || "unknown"}`,
        details: cap
      });
    }

    const pu = cap?.purchase_units?.[0] || {};
    const ship = pu?.shipping?.address || {};
    const name = pu?.shipping?.name?.full_name || "";
    const payer = cap?.payer || {};
    const [given_name, ...rest] = (
      name ||
      `${payer?.name?.given_name || ""} ${payer?.name?.surname || ""}`
    )
      .trim()
      .split(" ");
    const surname = rest.join(" ").trim();

    const address = {
      firstName: given_name || payer?.name?.given_name || "",
      lastName: surname || payer?.name?.surname || "",
      address1: ship?.address_line_1 || "",
      city: ship?.admin_area_2 || "",
      zip: ship?.postal_code || "",
      country: ship?.country_code || "",
      phone: "",
      email: payer?.email_address || ""
    };

    const captureId =
      pu?.payments?.captures?.[0]?.id ||
      pu?.payments?.authorizations?.[0]?.id ||
      cap?.id;

    res.json({ ok: true, captureId, address, raw: cap });
  } catch (e) {
    console.error("❌ /capture:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 4) Create Shopify Order (Draft -> Complete) بعد نجاح الدفع
app.post("/api/shopify/order-from-paypal", async (req, res) => {
  try {
    const b = req.body || {};
    const errs = [];

    // التحقق من الحقول المطلوبة
    if (!Array.isArray(b.line_items) || b.line_items.length === 0)
      errs.push("line_items is required");

    const A = b.address || {};
    ["firstName", "lastName", "address1", "city", "zip", "country"].forEach(k => {
      if (!A[k]) errs.push(`address.${k} is required`);
    });

    if (!b.shipping_label) errs.push("shipping_label is required");
    if (b.shipping_price == null) errs.push("shipping_price is required");

    if (errs.length) return res.status(400).json({ ok: false, error: "Invalid payload", details: errs });

    // بناء مدخل الدرفـت
    const draftOrderCreate = `
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id }
          userErrors { field message }
        }
      }
    `;

    const draftInput = {
      email: A.email || undefined, // الإيميل العام على مستوى الطلب
      billingAddress: {
        firstName: A.firstName,
        lastName: A.lastName,
        address1: A.address1,
        city: A.city,
        zip: A.zip,
        country: A.country,
        phone: A.phone || null
      },
      shippingAddress: {
        firstName: A.firstName,
        lastName: A.lastName,
        address1: A.address1,
        city: A.city,
        zip: A.zip,
        country: A.country,
        phone: A.phone || null
      },
      lineItems: b.line_items.map(li => ({
        variantId: toVariantGID(li.variant_id),
        quantity: parseInt(li.quantity, 10),
        // price (اختياري): إذا بدك تفرض سعر مختلف، وإلا Shopify بيحسب من المتجر
        price: li.price ? String(li.price) : null
      })),
      shippingLine:
        b.shipping_price !== "" && b.shipping_price != null
          ? {
              title: b.shipping_label || "Shipping",
              price: String(b.shipping_price)
            }
          : null,
      note: `PayPal order ${b.paypalOrderId || ""} | capture ${b.paypalCaptureId || ""}`.trim()
    };

    const d1 = await shopifyGraphQL(draftOrderCreate, { input: draftInput });
    const ue1 = d1?.draftOrderCreate?.userErrors || [];
    if (ue1.length) {
      return res.status(400).json({ ok: false, error: "Shopify user errors", details: ue1 });
    }

    const draftId = d1?.draftOrderCreate?.draftOrder?.id;
    if (!draftId) {
      return res.status(400).json({ ok: false, error: "Failed to create draft order", details: d1 });
    }

    const draftOrderComplete = `
      mutation draftOrderComplete($id: ID!) {
        draftOrderComplete(id: $id) {
          draftOrder { id order { id name } }
          userErrors { field message }
        }
      }
    `;

    const d2 = await shopifyGraphQL(draftOrderComplete, { id: draftId });
    const ue2 = d2?.draftOrderComplete?.userErrors || [];
    if (ue2.length) {
      return res.status(400).json({ ok: false, error: "Shopify user errors", details: ue2 });
    }

    const orderNode = d2?.draftOrderComplete?.draftOrder?.order;
    if (!orderNode?.id) {
      return res.status(400).json({ ok: false, error: "Unable to complete draft order", details: d2 });
    }

    res.json({ ok: true, order: orderNode });
  } catch (e) {
    console.error("❌ /order-from-paypal:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 5) Health check
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ───────────── Start ─────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ API listening on :${PORT}`);
  if (ORIGINS === "*") {
    console.log("🌍 CORS: * (all origins allowed)");
  } else {
    console.log("🌍 CORS allowed origins:", ORIGINS);
  }
});
