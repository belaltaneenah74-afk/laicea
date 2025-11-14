// server.js
// Simple PayPal → Shopify bridge (DraftOrder + Complete) مع أسعار مخصّصة لكل بند

const express = require('express');
const cors = require('cors');

const app = express();

// 🛡 السماح للمتاجر تطلب من السيرفر
app.use(cors());
app.use(express.json());

// 🧩 متغيرات البيئة (تضبطها من لوحة Render)
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP; // مثال: my-store.myshopify.com
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-04';
const SHOPIFY_CURRENCY = process.env.SHOPIFY_CURRENCY || 'USD'; // مثال: USD أو EUR

if (!SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) {
  console.error('❌ Missing SHOPIFY_SHOP or SHOPIFY_ACCESS_TOKEN env vars');
}

// 🧠 دالة لاستدعاء Shopify GraphQL
async function shopifyGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await res.json();
  if (!res.ok || json.errors) {
    console.error('❌ Shopify GraphQL HTTP/Errors:', res.status, json.errors);
    throw new Error('Shopify GraphQL request failed');
  }
  return json.data;
}

// ✅ هيلث تشِك بسيط
app.get('/', (req, res) => {
  res.json({ ok: true, msg: 'PayPal → Shopify bridge running' });
});

// 🔥 إنشاء DraftOrder + تحويله إلى Order
app.post('/api/shopify/order-from-paypal', async (req, res) => {
  try {
    const payload = req.body || {};
    console.log('📥 Incoming payload:', JSON.stringify(payload, null, 2));

    const {
      line_items = [],
      shipping_price,
      shipping_label,
      address = {},
      paypalOrderId,
      paypalCaptureId
    } = payload;

    if (!Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).json({ ok: false, error: 'Missing line_items' });
    }

    // 🧮 تجهيز البنود مع سعر الوحدة المخصّص (unit_price) إن وجد
    const gqlLineItems = line_items.map((li) => {
      const qty = parseInt(li.quantity, 10) || 1;
      const variantGid = `gid://shopify/ProductVariant/${li.variant_id}`;

      const base = li.unit_price != null ? parseFloat(li.unit_price) : NaN;

      const result = {
        variantId: variantGid,
        quantity: qty
      };

      // لو فيه unit_price صحيح → نرسله كـ originalUnitPrice
      if (!isNaN(base)) {
        result.originalUnitPrice = {
          amount: base.toFixed(2),
          currencyCode: SHOPIFY_CURRENCY
        };
      }

      return result;
    });

    // 🧮 الشحن
    const shipAmountNum = parseFloat(shipping_price || '0') || 0;
    const shippingLine =
      shipAmountNum > 0
        ? {
            title: shipping_label || 'Shipping',
            price: {
              amount: shipAmountNum.toFixed(2),
              currencyCode: SHOPIFY_CURRENCY
            }
          }
        : null;

    // 🏠 عنوان الفاتورة والشحن
    const firstName = address.firstName || '';
    const lastName = address.lastName || '';
    const mailAddr = {
      firstName,
      lastName,
      address1: address.address1 || '',
      city: address.city || '',
      zip: address.zip || '',
      country: address.country || '',
      phone: address.phone || ''
    };

    const email = address.email || payload.email || '';

    // 🧾 ميوتشن إنشاء draftOrder
    const draftCreateMutation = `
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            name
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const draftInput = {
      lineItems: gqlLineItems,
      shippingLine: shippingLine || undefined,
      billingAddress: mailAddr,
      shippingAddress: mailAddr,
      email: email || undefined,
      note: `PayPal order ${paypalOrderId || ''} | capture ${paypalCaptureId || ''}`,
      customAttributes: [
        { key: 'paypal_order_id', value: paypalOrderId || '' },
        { key: 'paypal_capture_id', value: paypalCaptureId || '' }
      ]
    };

    const draftData = await shopifyGraphQL(draftCreateMutation, { input: draftInput });
    const draftResult = draftData.draftOrderCreate;
    if (draftResult.userErrors && draftResult.userErrors.length) {
      console.error('❌ draftOrderCreate userErrors:', draftResult.userErrors);
      return res.status(400).json({ ok: false, stage: 'draftOrderCreate', errors: draftResult.userErrors });
    }

    const draftId = draftResult.draftOrder.id;
    console.log('✅ DraftOrder created:', draftId);

    // 🧾 ميوتشن إكمال الـ Draft (تحويله إلى Order مع Payment Pending = true)
    const completeMutation = `
      mutation draftOrderComplete($id: ID!, $paymentPending: Boolean) {
        draftOrderComplete(id: $id, paymentPending: $paymentPending) {
          order {
            id
            name
            totalPriceSet {
              shopMoney { amount currencyCode }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const completeData = await shopifyGraphQL(completeMutation, {
      id: draftId,
      paymentPending: true
    });

    const completeResult = completeData.draftOrderComplete;
    if (completeResult.userErrors && completeResult.userErrors.length) {
      console.error('❌ draftOrderComplete userErrors:', completeResult.userErrors);
      return res.status(400).json({ ok: false, stage: 'draftOrderComplete', errors: completeResult.userErrors });
    }

    console.log('✅ Order created:', completeResult.order);

    return res.json({
      ok: true,
      draftId,
      order: completeResult.order
    });
  } catch (err) {
    console.error('💥 Server error in /api/shopify/order-from-paypal:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// 🚀 تشغيل السيرفر
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
