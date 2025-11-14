// server.js
// ===============================
// Express server لاستقبال بيانات PayPal
// وإنشاء طلب مدفوع Paid في Shopify بنفس المبلغ
// ===============================

const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

// إعدادات Shopify من متغيرات البيئة
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;              // مثال: myshop.myshopify.com
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2023-10";

if (!SHOPIFY_STORE || !SHOPIFY_ACCESS_TOKEN) {
  console.warn("⚠️  SHOPIFY_STORE أو SHOPIFY_ACCESS_TOKEN غير موجودين في متغيرات البيئة!");
}

// --------------------
// Middleware
// --------------------
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --------------------
// دالة: إنشاء Order في Shopify
// --------------------
async function createShopifyOrder(orderPayload) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ order: orderPayload }),
  });

  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = {}; }

  if (!resp.ok || !data.order) {
    const msg = data.errors
      ? JSON.stringify(data.errors)
      : text || "Unknown Shopify error";
    const err = new Error(msg);
    err.status = resp.status;
    throw err;
  }
  return data.order;
}

// --------------------
// بناء payload من جسم الطلب
// --------------------
function buildOrderFromBody(body) {
  const {
    paypalOrderId,
    paypalCaptureId,
    total_paid,
    currency,
    shipping_label,
    shipping_price,
    address,
    line_items,
  } = body || {};

  if (!Array.isArray(line_items) || !line_items.length) {
    throw new Error("Missing or empty line_items");
  }
  if (!total_paid || !currency) {
    throw new Error("Missing total_paid or currency");
  }

  const total = parseFloat(total_paid);
  if (!isFinite(total) || total <= 0) {
    throw new Error("Invalid total_paid");
  }

  const shipPrice = parseFloat(shipping_price || "0") || 0;

  // 👇 نستخدم price المرسَل من صفحة التشيك أوت (بعد الخصم / البندل)
  const lineItemsPayload = line_items.map((li) => {
    const out = {
      variant_id: li.variant_id,
      quantity: li.quantity,
    };
    if (li.price != null) {
      const p = parseFloat(li.price);
      if (isFinite(p) && p >= 0) {
        out.price = p.toFixed(2); // سعر الوحدة
      }
    }
    return out;
  });

  const email = address && address.email;

  const shippingAddress = address
    ? {
        first_name: address.firstName || "",
        last_name: address.lastName || "",
        address1: address.address1 || "",
        city: address.city || "",
        zip: address.zip || "",
        country: address.country || "",
        phone: address.phone || "",
      }
    : undefined;

  const orderPayload = {
    email,
    send_receipt: false,
    send_fulfillment_receipt: false,
    financial_status: "paid",
    currency,

    billing_address: shippingAddress,
    shipping_address: shippingAddress,

    shipping_lines:
      shipPrice > 0
        ? [
            {
              title: shipping_label || "Shipping",
              price: shipPrice.toFixed(2),
              code: "ExternalPayPal",
            },
          ]
        : [],

    line_items: lineItemsPayload,

    transactions: [
      {
        kind: "sale",
        status: "success",
        amount: total.toFixed(2),
        currency,
        gateway: "PayPal (Custom)",
        authorization: paypalCaptureId || paypalOrderId || "",
      },
    ],

    note: `PayPal order: ${paypalOrderId || "n/a"} | capture: ${
      paypalCaptureId || "n/a"
    }`,
  };

  return orderPayload;
}

// --------------------
// الراوت: يُستخدم من صفحة التشيك أوت
// --------------------
app.post(
  ["/api/shopify/order-from-paypal-fixed", "/api/shopify/order-from-paypal"],
  async (req, res) => {
    try {
      console.log("Incoming payload:", JSON.stringify(req.body, null, 2));

      const orderPayload = buildOrderFromBody(req.body || {});
      const shopifyOrder = await createShopifyOrder(orderPayload);

      console.log("Order created:", shopifyOrder.id, shopifyOrder.name);

      return res.status(200).json({
        ok: true,
        order_id: shopifyOrder.id,
        name: shopifyOrder.name,
      });
    } catch (err) {
      console.error("ORDER CREATE ERROR:", err.status, err.message);
      return res.status(500).json({
        ok: false,
        error: err.message || "Order creation failed",
      });
    }
  }
);

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log("✅ Server listening on port", PORT);
});
