// server.js - نهائي

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// تأكد من وجود هذه الـ ENV في Render
const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // example: my-store.myshopify.com
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const DEFAULT_ORDER_EMAIL = process.env.DEFAULT_ORDER_EMAIL || 'orders@example.com';

if (!SHOPIFY_STORE || !SHOPIFY_ACCESS_TOKEN) {
  console.warn('⚠️ Please set SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN in environment variables.');
}

// هيلبر بسيط لاستدعاء Shopify REST Admin API
async function shopifyRequest(path, options = {}) {
  const url = `https://${SHOPIFY_STORE}/admin/api/2024-01${path}`;

  const headers = {
    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...(options.headers || {})
  };

  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { raw: text }; }

  if (!res.ok) {
    throw new Error(
      `Shopify error ${res.status}: ${JSON.stringify(json)}`
    );
  }
  return json;
}

// صحّة السيرفر
app.get('/', (_req, res) => {
  res.json({ ok: true, msg: 'PayPal → Shopify bridge running.' });
});

/**
 * POST /api/shopify/order-from-paypal
 * يستقبل:
 * {
 *   paypalOrderId,
 *   paypalCaptureId,
 *   address: {
 *     firstName, lastName, address1, city, zip, country, email, phone
 *   },
 *   shipping_label,
 *   shipping_price (string أو رقم),
 *   line_items: [
 *     { variant_id, quantity, price }  // price = سعر الوحدة بعد الخصم (مثلاً 2.00)
 *   ]
 * }
 */
app.post('/api/shopify/order-from-paypal', async (req, res) => {
  try {
    const {
      paypalOrderId,
      paypalCaptureId,
      address,
      shipping_label,
      shipping_price,
      line_items
    } = req.body || {};

    if (!Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).json({ ok: false, error: 'Missing line_items' });
    }

    // 🔹 تجهيز line_items للـ Order
    const orderLineItems = line_items.map(li => {
      const out = {
        variant_id: li.variant_id,
        quantity: li.quantity || 1
      };
      if (li.price != null) {
        // نضمن أنها سترينغ بصيغة 2.00
        const p = Number(li.price);
        if (!Number.isNaN(p)) {
          out.price = p.toFixed(2);
        }
      }
      return out;
    });

    // 🔹 تجهيز العناوين (بدون email داخل العنوان عشان Shopify)
    let shipping_address;
    let billing_address;
    let orderEmail = DEFAULT_ORDER_EMAIL;

    if (address) {
      shipping_address = {
        first_name: address.firstName || '',
        last_name:  address.lastName || '',
        address1:   address.address1 || '',
        city:       address.city || '',
        zip:        address.zip || '',
        country:    address.country || '',
        phone:      address.phone || ''
      };

      billing_address = { ...shipping_address };

      if (address.email) {
        orderEmail = address.email;
      }
    }

    // 🔹 سطر الشحن (لو فيه شحن > 0)
    let shippingLines = [];
    const shipPriceNum = Number(shipping_price);
    if (!Number.isNaN(shipPriceNum) && shipPriceNum > 0) {
      shippingLines.push({
        title: shipping_label || 'Shipping',
        price: shipPriceNum.toFixed(2)
      });
    }

    // 🔹 بناء الـ Order payload
    const orderPayload = {
      order: {
        email: orderEmail,
        line_items: orderLineItems,
        shipping_address,
        billing_address,
        shipping_lines: shippingLines,
        financial_status: 'paid',
        note: `PayPal order ${paypalOrderId || ''}${paypalCaptureId ? ' | capture ' + paypalCaptureId : ''}`,
        tags: 'paypal-bridge'
      }
    };

    // 🔥 إنشاء طلب في Shopify
    const created = await shopifyRequest('/orders.json', {
      method: 'POST',
      body: JSON.stringify(orderPayload)
    });

    return res.json({
      ok: true,
      order: created.order ? {
        id: created.order.id,
        name: created.order.name,
        total_price: created.order.total_price
      } : created
    });
  } catch (err) {
    console.error('❌ Shopify order create failed:', err.message);
    return res.status(500).json({
      ok: false,
      error: 'Shopify order creation failed',
      detail: err.message
    });
  }
});

// تشغيل السيرفر
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
