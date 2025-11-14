// server.js
// ===============================
// Express server لاستقبال طلبات PayPal
// وإنشاء طلب مدفوع Paid في Shopify بنفس المبلغ
// ===============================

const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

// إعدادات Shopify من متغيرات البيئة
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;              // مثال:  myshop.myshopify.com
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2023-10";

if (!SHOPIFY_STORE || !SHOPIFY_ACCESS_TOKEN) {
  console.warn(
    "⚠️  SHOPIFY_STORE أو SHOPIFY_ACCESS_TOKEN غير موجودين في متغيرات البيئة!"
  );
}

// --------------------
// Middleware عام
// --------------------
app.use(express.json());

// CORS بسيط عشان Shopify page تقدر تكلم Render
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --------------------
// دالة مساعدة: إنشاء أوردر في Shopify
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
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = {};
  }

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
// دالة مساعدة: بناء Payload الأوردر من Body الريكوست
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
  const desiredSubtotal = +(total - shipPrice).toFixed(2);

  // نحضّر البنود اللي جاية من الفرونت
  const items = line_items.map((li) => ({
    variant_id: li.variant_id,
    quantity: li.quantity,
    price: li.price != null ? parseFloat(li.price) : null, // price = سعر الوحدة (اختياري)
  }));

  const haveCustomPrices = items.some((it) => it.price != null);

  let lineItemsPayload;

  if (haveCustomPrices) {
    // لو جايينا أسعار من الـ Checkout → نستخدمها ونضبطها إذا الفروقات بسيطة
    let currentSubtotal = items.reduce(
      (s, it) => s + (it.price || 0) * (it.quantity || 0),
      0
    );

    currentSubtotal = +currentSubtotal.toFixed(2);

    if (
      desiredSubtotal > 0 &&
      Math.abs(currentSubtotal - desiredSubtotal) > 0.02
    ) {
      // اختلاف بسيط → نوزع الفرق نسبة وتناسب
      let running = 0;
      lineItemsPayload = items.map((it, idx) => {
        const baseLine = (it.price || 0) * (it.quantity || 0);
        const share =
          currentSubtotal > 0 ? baseLine / currentSubtotal : 1 / items.length;

        let newLine;
        if (idx < items.length - 1) {
          newLine = +(desiredSubtotal * share).toFixed(2);
          running += newLine;
        } else {
          newLine = +(desiredSubtotal - running).toFixed(2);
        }

        const unit = +(newLine / (it.quantity || 1)).toFixed(2);

        return {
          variant_id: it.variant_id,
          quantity: it.quantity,
          price: unit.toFixed(2), // 👈 هذا اللي Shopify بيستخدمه كسعر الوحدة
        };
      });
    } else {
      // ما في فرق كبير → استخدم الأسعار كما هي
      lineItemsPayload = items.map((it) => ({
        variant_id: it.variant_id,
        quantity: it.quantity,
        price: (it.price || 0).toFixed(2),
      }));
    }
  } else {
    // ما في prices → خلّي Shopify يستخدم أسعار المتغيرات الافتراضية
    lineItemsPayload = items.map((it) => ({
      variant_id: it.variant_id,
      quantity: it.quantity,
    }));
  }

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
// الراوت الرئيسي: نستخدمه مع التشيك أوت الجديد
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

// Health check بسيط
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Start
app.listen(PORT, () => {
  console.log("✅ Server listening on port", PORT);
});
