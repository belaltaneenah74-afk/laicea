// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// إعدادات أساسية
app.use(cors());
app.use(express.json());

// من الـ .env
const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // مثال: "laicea"
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN; // Admin API Token

if (!SHOPIFY_STORE || !SHOPIFY_ACCESS_TOKEN) {
  console.warn('⚠️ Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN in environment!');
}

// Shopify GraphQL endpoint
const SHOPIFY_ADMIN_URL = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2024-04/graphql.json`;

// دالة مساعدة لطلب GraphQL من Shopify
async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(SHOPIFY_ADMIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.errors) {
    console.error('Shopify top-level errors:', JSON.stringify(json.errors, null, 2));
    throw new Error('Shopify GraphQL top-level error');
  }
  return json.data;
}

// 🧪 Health check
app.get('/', (req, res) => {
  res.send('PayPal → Shopify bridge is running ✅');
});

// 🔐 المسار الرئيسي لإنشاء أوردر Shopify بعد نجاح الدفع من PayPal
app.post('/api/shopify/order-from-paypal', async (req, res) => {
  try {
    const payload = req.body || {};

    const {
      paypalOrderId,
      paypalCaptureId,
      address,
      shipping_label,
      shipping_price,
      line_items,
    } = payload;

    if (!line_items || !Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).json({ ok: false, error: 'Missing line_items' });
    }

    // ✅ نقرأ line_items كما جاءت من صفحة Checkout
    // كل عنصر: { variant_id, quantity, price }
    const lineItemsInput = line_items.map((li) => {
      if (!li.variant_id || !li.quantity) {
        throw new Error('Invalid line item in payload');
      }

      const base = {
        variantId: `gid://shopify/ProductVariant/${li.variant_id}`,
        quantity: parseInt(li.quantity, 10),
      };

      // لو فيه price جاي من الكلاينت (بعد الخصم) نرسله كما هو
      if (li.price != null) {
        base.price = li.price.toString(); // Shopify expects String
      }

      return base;
    });

    const shippingPriceNum = shipping_price ? parseFloat(shipping_price) : 0;
    const shippingLine =
      shippingPriceNum > 0
        ? {
            title: shipping_label || 'Shipping',
            price: shippingPriceNum.toFixed(2),
          }
        : null;

    const addr = address || {};
    const mailingAddress = {
      firstName: addr.firstName || '',
      lastName: addr.lastName || '',
      address1: addr.address1 || '',
      city: addr.city || '',
      zip: addr.zip || '',
      country: addr.country || '',
      phone: addr.phone || '',
    };

    const email = addr.email || undefined;

    // 🧾 إنشاء Draft Order
    const draftOrderInput = {
      email,
      billingAddress: mailingAddress,
      shippingAddress: mailingAddress,
      lineItems: lineItemsInput,
      note: `PayPal order ${paypalOrderId || ''}${
        paypalCaptureId ? ' | capture ' + paypalCaptureId : ''
      }`,
    };

    if (shippingLine) {
      draftOrderInput.shippingLine = shippingLine;
    }

    const DRAFT_ORDER_CREATE = `
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

    const createData = await shopifyGraphQL(DRAFT_ORDER_CREATE, {
      input: draftOrderInput,
    });

    const createRes = createData.draftOrderCreate;
    if (createRes.userErrors && createRes.userErrors.length > 0) {
      console.error('Shopify draftOrderCreate userErrors:', createRes.userErrors);
      return res.status(500).json({
        ok: false,
        error: 'Shopify draftOrderCreate userErrors',
        details: createRes.userErrors,
      });
    }

    const draftOrderId = createRes.draftOrder.id;

    // ✅ إكمال الـ DraftOrder وتحويله إلى Order
    const DRAFT_ORDER_COMPLETE = `
      mutation draftOrderComplete($id: ID!, $paymentPending: Boolean!) {
        draftOrderComplete(id: $id, paymentPending: $paymentPending) {
          draftOrder {
            id
            order {
              id
              name
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const completeData = await shopifyGraphQL(DRAFT_ORDER_COMPLETE, {
      id: draftOrderId,
      paymentPending: false, // الدفع تم فعليًا في PayPal
    });

    const completeRes = completeData.draftOrderComplete;
    if (completeRes.userErrors && completeRes.userErrors.length > 0) {
      console.error('Shopify draftOrderComplete userErrors:', completeRes.userErrors);
      return res.status(500).json({
        ok: false,
        error: 'Shopify draftOrderComplete userErrors',
        details: completeRes.userErrors,
      });
    }

    const orderInfo = completeRes.draftOrder?.order || null;

    return res.json({
      ok: true,
      order: orderInfo,
    });
  } catch (err) {
    console.error('❌ Shopify Order Error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
});

// (اختياري) مسار قديم لـ /api/paypal/create-order لو لسه فيه كود قديم بيضربه
app.post('/api/paypal/create-order', (req, res) => {
  return res.status(400).json({
    ok: false,
    error: 'This endpoint is not used. Frontend uses client-side PayPal SDK.',
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
