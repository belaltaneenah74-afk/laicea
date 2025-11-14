// server.js - نهائي مع دعم خصومات البندل
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ندعم أكثر من اسم لمتغيرات البيئة عشان ما نخرب إعداداتك القديمة
const SHOPIFY_STORE =
  process.env.SHOPIFY_STORE ||
  process.env.SHOPIFY_STORE_DOMAIN ||
  process.env.SHOPIFY_SHOP;

const SHOPIFY_ACCESS_TOKEN =
  process.env.SHOPIFY_ACCESS_TOKEN ||
  process.env.SHOPIFY_ADMIN_API_TOKEN ||
  process.env.SHOPIFY_API_PASSWORD;

const DEFAULT_ORDER_EMAIL = process.env.DEFAULT_ORDER_EMAIL || 'orders@example.com';

if (!SHOPIFY_STORE || !SHOPIFY_ACCESS_TOKEN) {
  console.warn('⚠️ Please set SHOPIFY_STORE / SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN in environment variables.');
}

// هيلبر لاستدعاء Shopify REST Admin API
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
    throw new Error(`Shopify ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

// فحص صحة السيرفر
app.get('/', (_req, res) => {
  res.json({ ok: true, msg: 'PayPal → Shopify bridge running' });
});

/**
 * POST /api/shopify/order-from-paypal
 * body:
 * {
 *   paypalOrderId,
 *   paypalCaptureId,
 *   address: { firstName, lastName, address1, city, zip, country, email, phone },
 *   shipping_label,
 *   shipping_price,
 *   line_items: [
 *     { variant_id, quantity, price }   // price = سعر الوحدة بعد الخصم (مثلاً 2.00)
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

    // ✅ نحضّر line_items للدرافـت أوردر مع سعر الوحدة المخصّص (بعد الخصم)
    const draftLineItems = line_items.map(li => {
      const qty = li.quantity || 1;
      const out = {
        variant_id: li.variant_id,
        quantity: qty
      };
      if (li.price != null) {
        const p = Number(li.price);
        if (!Number.isNaN(p)) {
          out.price = p.toFixed(2);
        }
      }
      return out;
    });

    // 🔹 العناوين
    let shipping_address;
    let billing_address;
    let orderEmail = DEFAULT_ORDER_EMAIL;

    if (address) {
      shipping_address = {
        first_name: address.firstName || '',
        last_name:  address.lastName  || '',
        address1:   address.address1  || '',
        city:       address.city      || '',
        zip:        address.zip       || '',
        country:    address.country   || '',
        phone:      address.phone     || ''
      };
      billing_address = { ...shipping_address };

      if (address.email) orderEmail = address.email;
    }

    // 🔹 الشحن في الدرافـت أوردر
    let shippingLine = undefined;
    const shipNum = Number(shipping_price);
    if (!Number.isNaN(shipNum) && shipNum > 0) {
      shippingLine = {
        title: shipping_label || 'Shipping',
        price: shipNum.toFixed(2)
      };
    }

    // 🧾 نبني الدرافـت أوردر
    const draftPayload = {
      draft_order: {
        email: orderEmail,
        line_items: draftLineItems,
        shipping_address,
        billing_address,
        shipping_line: shippingLine,
        use_customer_default_address: false,
        note: `PayPal order ${paypalOrderId || ''}${paypalCaptureId ? ' | capture ' + paypalCaptureId : ''}`,
        tags: 'paypal-bridge'
      }
    };

    // 1) نُنشئ Draft Order
    const draft = await shopifyRequest('/draft_orders.json', {
      method: 'POST',
      body: JSON.stringify(draftPayload)
    });

    if (!draft || !draft.draft_order || !draft.draft_order.id) {
      throw new Error('Draft order creation returned invalid response');
    }

    const draftId = draft.draft_order.id;

    // 2) نكمّل الدرافـت أوردر إلى Order حقيقي (مدفوع)
    const completed = await shopifyRequest(`/draft_orders/${draftId}/complete.json`, {
      method: 'PUT',
      body: JSON.stringify({ payment_pending: false }) // مدفوع بالفعل عبر بايبال
    });

    const order = completed.order || completed;

    return res.json({
      ok: true,
      order: {
        id: order.id,
        name: order.name,
        total_price: order.total_price
      }
    });
  } catch (err) {
    console.error('❌ Shopify order creation error:', err.message);
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
