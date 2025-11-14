// server.js - Final version for PayPal → Shopify Checkout
// -----------------------------------------------
// Requires: express, cors, node-fetch (v2)
// In package.json تأكد من وجود:
// "dependencies": {
//   "express": "^4.18.2",
//   "cors": "^2.8.5",
//   "node-fetch": "^2.6.7"
// }

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Environment variables (من Render)
const {
  SHOPIFY_STORE,          // مثال: iptcy7-up
  SHOPIFY_ACCESS_TOKEN,   // Admin API access token
  SHOPIFY_API_VERSION,    // اختياري – مثال: 2024-01
  SHOPIFY_CURRENCY,       // مثال: USD أو EUR
  PAYPAL_CLIENT_ID,       // (اختياري) لو بدك تتحقّق من الكابتشر من السيرفر
  PAYPAL_CLIENT_SECRET,
  PORT
} = process.env;

const apiVersion = SHOPIFY_API_VERSION || '2024-01';

if (!SHOPIFY_STORE || !SHOPIFY_ACCESS_TOKEN) {
  console.error('❌ Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN in env');
}

// 🔧 دالة مساعدة لاستدعاء Shopify GraphQL
async function shopifyGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/${apiVersion}/graphql.json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  const data = await res.json();

  if (!res.ok || data.errors) {
    console.error('❌ Shopify GraphQL HTTP error or top-level errors:', data);
    throw new Error('SHOPIFY_GRAPHQL_ERROR');
  }

  return data;
}

// ✅ Healthcheck بسيط
app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'UP' });
});

// ✅ المسار الرئيسي: إنشاء أوردر Shopify بعد دفع PayPal
app.post('/api/shopify/order-from-paypal', async (req, res) => {
  try {
    const {
      paypalOrderId,
      paypalCaptureId,
      total_paid,
      currency,
      address,
      shipping_label,
      shipping_price,
      line_items
    } = req.body || {};

    // تحقق من الداتا الأساسية
    if (!line_items || !Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).json({ ok: false, error: 'NO_LINE_ITEMS' });
    }

    // 1️⃣ نحصل على المبلغ المدفوع فعليًا
    let paidAmount = total_paid ? parseFloat(total_paid) : null;

    // لو ما وصل total_paid (حالة احتياطية) نحاول نقرأ من PayPal API
    if ((!paidAmount || isNaN(paidAmount)) && paypalCaptureId && PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET) {
      try {
        const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
        const capRes = await fetch(`https://api-m.paypal.com/v2/payments/captures/${paypalCaptureId}`, {
          headers: { 'Authorization': `Basic ${basic}` }
        });
        const capJson = await capRes.json();
        if (capRes.ok && capJson && capJson.amount && capJson.amount.value) {
          paidAmount = parseFloat(capJson.amount.value);
        }
      } catch (e) {
        console.error('⚠️ Failed to fetch capture from PayPal:', e);
      }
    }

    if (!paidAmount || isNaN(paidAmount)) {
      console.error('❌ INVALID_TOTAL_PAID:', total_paid);
      return res.status(400).json({ ok: false, error: 'INVALID_TOTAL_PAID' });
    }

    // 2️⃣ تقسيم المبلغ بين الشحن والمنتجات
    const shipPrice = parseFloat(shipping_price || 0) || 0;
    const itemsTotalTarget = +(paidAmount - shipPrice).toFixed(2);
    if (itemsTotalTarget < 0) {
      console.error('❌ Items total < 0. paidAmount=', paidAmount, ' shipPrice=', shipPrice);
      return res.status(400).json({ ok: false, error: 'NEGATIVE_ITEMS_TOTAL' });
    }

    // 3️⃣ توزيع مبلغ المنتجات على البنود حسب الكمية
    const totalUnits = line_items.reduce((sum, it) => sum + (it.quantity || 1), 0);
    if (totalUnits <= 0) {
      return res.status(400).json({ ok: false, error: 'INVALID_QUANTITIES' });
    }

    const currencyCode = (currency || SHOPIFY_CURRENCY || 'USD').toUpperCase();

    let running = 0;
    const gqlLineItems = line_items.map((it, idx) => {
      const qty = it.quantity || 1;

      // توزيع نسبي بسيط: كل قطعة تاخد حصة من المجموع
      let lineAmount;
      if (idx < line_items.length - 1) {
        const share = qty / totalUnits;
        lineAmount = +(itemsTotalTarget * share).toFixed(2);
        running += lineAmount;
      } else {
        // آخر بند يأخذ الباقي لتصحيح فروقات التقريب
        lineAmount = +(itemsTotalTarget - running).toFixed(2);
      }

      const unitPrice = +(lineAmount / qty).toFixed(2);

      return {
        variantId: `gid://shopify/ProductVariant/${it.variant_id}`,
        quantity: qty,
        originalUnitPrice: {
          amount: unitPrice,
          currencyCode
        }
      };
    });

    // 4️⃣ عنوان الشحن/الفاتورة
    const shippingAddress = address ? {
      firstName: address.firstName || 'PayPal',
      lastName:  address.lastName  || 'Customer',
      address1:  address.address1  || '',
      city:      address.city      || '',
      zip:       address.zip       || '',
      country:   address.country   || 'US',
      phone:     address.phone     || null
    } : null;

    const input = {
      lineItems: gqlLineItems,
      note: (`PayPal order ${paypalOrderId || ''} | capture ${paypalCaptureId || ''}`).trim()
    };

    if (shippingAddress) {
      input.shippingAddress = shippingAddress;
      input.billingAddress  = shippingAddress; // بدون email (ممنوعة في MailingAddressInput)
    }

    if (shipPrice > 0 && shipping_label) {
      input.shippingLine = {
        title: shipping_label,
        price: shipPrice.toFixed(2)
      };
    }

    // 5️⃣ إنشاء DraftOrder
    const createMutation = `
      mutation DraftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id name }
          userErrors { field message }
        }
      }
    `;

    const created = await shopifyGraphQL(createMutation, { input });
    const draftRes = created.data.draftOrderCreate;

    if (draftRes.userErrors && draftRes.userErrors.length) {
      console.error('❌ draftOrderCreate userErrors:', draftRes.userErrors);
      return res.status(500).json({ ok: false, error: 'DRAFT_ORDER_USER_ERRORS', details: draftRes.userErrors });
    }

    const draftId = draftRes.draftOrder.id;

    // 6️⃣ تحويل الـ Draft لطلب حقيقي (مدفوع)
    const completeMutation = `
      mutation DraftOrderComplete($id: ID!, $paymentPending: Boolean) {
        draftOrderComplete(id: $id, paymentPending: $paymentPending) {
          order { id name }
          userErrors { field message }
        }
      }
    `;

    const completed = await shopifyGraphQL(completeMutation, {
      id: draftId,
      paymentPending: false
    });

    const completeRes = completed.data.draftOrderComplete;
    if (completeRes.userErrors && completeRes.userErrors.length) {
      console.error('❌ draftOrderComplete userErrors:', completeRes.userErrors);
      return res.status(500).json({ ok: false, error: 'COMPLETE_USER_ERRORS', details: completeRes.userErrors });
    }

    console.log('✅ Shopify order created:', completeRes.order);
    return res.json({ ok: true, order: completeRes.order });

  } catch (err) {
    console.error('💥 /api/shopify/order-from-paypal error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// Start server
const port = PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
