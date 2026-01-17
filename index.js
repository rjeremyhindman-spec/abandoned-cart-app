require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');

const app = express();
app.use(express.json());

// ===================
// TEST MODE SETTINGS
// ===================
const TEST_MODE = true;  // SET TO false WHEN READY TO GO LIVE
const TEST_EMAIL = 'rjeremyhindman@gmail.com';  // Only this email will receive emails in test mode

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// BigCommerce API config
const BC_STORE_HASH = process.env.BC_STORE_HASH;
const BC_ACCESS_TOKEN = process.env.BC_ACCESS_TOKEN;

// MailerLite API config
const MAILERLITE_API_KEY = process.env.MAILERLITE_API_KEY;

// ===================
// DATABASE SETUP
// ===================
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS abandoned_carts (
        id SERIAL PRIMARY KEY,
        cart_id VARCHAR(255) UNIQUE NOT NULL,
        customer_email VARCHAR(255),
        customer_id INTEGER,
        cart_data JSONB,
        cart_total DECIMAL(10,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        converted BOOLEAN DEFAULT FALSE,
        email_sent_1 BOOLEAN DEFAULT FALSE,
        email_sent_2 BOOLEAN DEFAULT FALSE,
        email_sent_3 BOOLEAN DEFAULT FALSE
      );

      CREATE TABLE IF NOT EXISTS browse_events (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255),
        customer_email VARCHAR(255),
        product_id INTEGER,
        product_name VARCHAR(255),
        product_url VARCHAR(500),
        product_image VARCHAR(500),
        product_price DECIMAL(10,2),
        viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        added_to_cart BOOLEAN DEFAULT FALSE,
        email_sent BOOLEAN DEFAULT FALSE
      );

      CREATE TABLE IF NOT EXISTS email_log (
        id SERIAL PRIMARY KEY,
        email_type VARCHAR(50),
        recipient_email VARCHAR(255),
        subject VARCHAR(255),
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        cart_id VARCHAR(255),
        product_id INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_abandoned_carts_email ON abandoned_carts(customer_email);
      CREATE INDEX IF NOT EXISTS idx_abandoned_carts_converted ON abandoned_carts(converted);
      CREATE INDEX IF NOT EXISTS idx_browse_events_email ON browse_events(customer_email);
      CREATE INDEX IF NOT EXISTS idx_browse_events_viewed_at ON browse_events(viewed_at);
    `);
    console.log('Database tables initialized');
  } finally {
    client.release();
  }
}

// ===================
// BIGCOMMERCE API HELPERS
// ===================
async function fetchFromBigCommerce(endpoint) {
  const response = await fetch(`https://api.bigcommerce.com/stores/${BC_STORE_HASH}${endpoint}`, {
    headers: {
      'X-Auth-Token': BC_ACCESS_TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });
  
  if (!response.ok) {
    throw new Error(`BigCommerce API error: ${response.status}`);
  }
  
  return response.json();
}

async function getCartDetails(cartId) {
  try {
    const data = await fetchFromBigCommerce(`/v3/carts/${cartId}?include=line_items.physical_items.options`);
    return data.data;
  } catch (error) {
    console.error('Error fetching cart:', error);
    return null;
  }
}

async function getCustomerEmail(customerId) {
  try {
    const data = await fetchFromBigCommerce(`/v3/customers?id:in=${customerId}`);
    if (data.data && data.data.length > 0) {
      return data.data[0].email;
    }
  } catch (error) {
    console.error('Error fetching customer:', error);
  }
  return null;
}

// ===================
// EMAIL TEMPLATES
// ===================
function buildAbandonedCartEmail(customerName, product) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f4; font-family: Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f4f4f4;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: #ffffff; border-radius: 8px; overflow: hidden;">
          
          <!-- HEADER -->
          <tr>
            <td align="center" style="padding: 30px 40px; background-color: #42aba5;">
              <img src="https://cdn11.bigcommerce.com/s-m91f4azz/images/stencil/original/image-manager/untitled-design-5-.png?t=1768433349" alt="Peek-a-Boo Pattern Shop" width="250" style="display: block; max-width: 250px; height: auto;">
            </td>
          </tr>
          
          <!-- HEADLINE -->
          <tr>
            <td align="center" style="padding: 40px 40px 20px;">
              <h1 style="margin: 0; font-family: Georgia, serif; font-size: 28px; color: #312c2d;">Oops! You left something behind...</h1>
            </td>
          </tr>
          
          <!-- INTRO -->
          <tr>
            <td style="padding: 0 40px 30px; text-align: center; font-size: 16px; color: #666666; line-height: 1.6;">
              Your cart is feeling a little lonely! We saved your items so you can pick up right where you left off.
            </td>
          </tr>
          
          <!-- PRODUCT CARD -->
          <tr>
            <td align="center" style="padding: 0 40px 30px;">
              <table cellpadding="0" cellspacing="0" border="0" style="background: #fafafa; border-radius: 8px; overflow: hidden; border: 1px solid #eee; max-width: 400px; width: 100%;">
                <tr>
                  <td align="center" style="padding: 0;">
                    <a href="${product.url}">
                      <img src="${product.image}" alt="${product.name}" width="400" style="display: block; width: 100%; height: auto;">
                    </a>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 25px; text-align: center;">
                    <p style="margin: 0 0 5px; font-size: 12px; color: #42aba5; text-transform: uppercase; letter-spacing: 1px;">In Your Cart</p>
                    <h3 style="margin: 0 0 10px; font-family: Georgia, serif; font-size: 20px; color: #312c2d;">${product.name}</h3>
                    <p style="margin: 0; font-size: 18px; color: #a71e32; font-weight: bold;">$${product.price}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- CTA BUTTON -->
          <tr>
            <td align="center" style="padding: 0 40px 30px;">
              <a href="https://www.peekaboopatternshop.com/cart.php" style="display: inline-block; padding: 16px 50px; background-color: #a71e32; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: bold; border-radius: 5px; text-transform: uppercase; letter-spacing: 1px;">Complete My Order</a>
            </td>
          </tr>
          
          <!-- FEATURES -->
          <tr>
            <td align="center" style="padding: 0 40px 30px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding: 0 15px; text-align: center; font-size: 12px; color: #888;">✨ Instant Download</td>
                  <td style="padding: 0 15px; text-align: center; font-size: 12px; color: #888;">🖨️ Printable Pattern</td>
                  <td style="padding: 0 15px; text-align: center; font-size: 12px; color: #888;">💕 300K+ Happy Sewists</td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- AMY QUOTE -->
          <tr>
            <td style="padding: 30px 40px; background-color: #fafafa; border-top: 1px solid #eee;">
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td width="60" valign="top">
                    <img src="https://cdn11.bigcommerce.com/s-m91f4azz/images/stencil/original/image-manager/amy-headshot.png" alt="Amy" width="50" style="border-radius: 50%;">
                  </td>
                  <td style="padding-left: 15px; font-size: 14px; color: #666; font-style: italic; line-height: 1.5;">
                    "Have questions about sizing or anything else? Just hit reply — my team and I are always happy to help!"
                    <br><br>
                    <strong style="color: #312c2d; font-style: normal;">— Amy</strong><br>
                    <span style="font-size: 12px; font-style: normal;">Founder & Pattern Designer</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- FOOTER -->
          <tr>
            <td style="padding: 30px 40px; text-align: center; font-size: 12px; color: #999999;">
              <p style="margin: 0 0 10px;">Peek-a-Boo Pattern Shop<br>205 Settlers Loop • United States</p>
              <p style="margin: 0;"><a href="{$unsubscribe}" style="color: #999999;">Unsubscribe</a></p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildBrowseAbandonmentEmail(customerName, products) {
  let productCards = '';
  
  products.forEach(product => {
    productCards += `
          <!-- PRODUCT CARD -->
          <tr>
            <td align="center" style="padding: 0 40px 25px;">
              <table cellpadding="0" cellspacing="0" border="0" style="background: #fafafa; border-radius: 8px; overflow: hidden; border: 1px solid #eee; max-width: 400px; width: 100%;">
                <tr>
                  <td align="center" style="padding: 0;">
                    <a href="${product.product_url}">
                      <img src="${product.product_image}" alt="${product.product_name}" width="400" style="display: block; width: 100%; height: auto;">
                    </a>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 25px; text-align: center;">
                    <h3 style="margin: 0 0 15px; font-family: Georgia, serif; font-size: 20px; color: #312c2d;">${product.product_name}</h3>
                    <a href="${product.product_url}" style="display: inline-block; padding: 14px 35px; background-color: #a71e32; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: bold; border-radius: 5px; text-transform: uppercase;">View Pattern</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`;
  });

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f4; font-family: Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f4f4f4;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: #ffffff; border-radius: 8px; overflow: hidden;">
          
          <!-- HEADER -->
          <tr>
            <td align="center" style="padding: 30px 40px; background-color: #42aba5;">
              <img src="https://cdn11.bigcommerce.com/s-m91f4azz/images/stencil/original/image-manager/untitled-design-5-.png?t=1768433349" alt="Peek-a-Boo Pattern Shop" width="250" style="display: block; max-width: 250px; height: auto;">
            </td>
          </tr>
          
          <!-- HEADLINE -->
          <tr>
            <td align="center" style="padding: 40px 40px 20px;">
              <h1 style="margin: 0; font-family: Georgia, serif; font-size: 28px; color: #312c2d;">Still thinking about it?</h1>
            </td>
          </tr>
          
          <!-- INTRO -->
          <tr>
            <td style="padding: 0 40px 30px; text-align: center; font-size: 16px; color: #666666; line-height: 1.6;">
              Hi ${customerName || 'there'},<br><br>
              We noticed you were checking out some patterns. In case you got distracted, here's what caught your eye:
            </td>
          </tr>
          
          ${productCards}
          
          <!-- DIVIDER -->
          <tr>
            <td align="center" style="padding: 15px 40px 25px;">
              <div style="width: 80px; height: 3px; background-color: #42aba5;"></div>
            </td>
          </tr>
          
          <!-- CTA -->
          <tr>
            <td align="center" style="padding: 0 40px 40px;">
              <h2 style="margin: 0 0 20px; font-family: Georgia, serif; font-size: 22px; color: #312c2d; font-weight: normal;">Ready to start your next project?</h2>
              <a href="https://www.peekaboopatternshop.com/sewing-patterns/" style="display: inline-block; padding: 16px 45px; background-color: #42aba5; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: bold; border-radius: 5px; text-transform: uppercase; letter-spacing: 1px;">Shop All Patterns</a>
            </td>
          </tr>
          
          <!-- FOOTER -->
          <tr>
            <td style="padding: 30px 40px; background-color: #fafafa; border-top: 1px solid #eee; text-align: center;">
              <p style="margin: 0 0 5px; font-size: 15px; color: #666;">Happy sewing!</p>
              <p style="margin: 0 0 20px; font-size: 15px; color: #312c2d; font-weight: bold;">The Peek-a-Boo Pattern Shop Team</p>
              <p style="margin: 0; font-size: 12px; color: #999999;">
                Peek-a-Boo Pattern Shop • 205 Settlers Loop • United States<br><br>
                <a href="{$unsubscribe}" style="color: #999999;">Unsubscribe</a>
              </p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ===================
// MAILERLITE API - SEND EMAIL
// ===================
async function sendEmailViaMailerLite(toEmail, subject, htmlContent) {
  // Check test mode
  if (TEST_MODE && toEmail.toLowerCase() !== TEST_EMAIL.toLowerCase()) {
    console.log(`TEST MODE: Skipping email to ${toEmail} (only sending to ${TEST_EMAIL})`);
    return false;
  }

  try {
    // First, ensure subscriber exists
    const subscriberResponse = await fetch('https://connect.mailerlite.com/api/subscribers', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MAILERLITE_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ email: toEmail })
    });

    // Create a campaign and send
    const campaignResponse = await fetch('https://connect.mailerlite.com/api/campaigns', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MAILERLITE_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        name: `${subject} - ${toEmail} - ${Date.now()}`,
        type: 'regular',
        emails: [{
          subject: subject,
          from_name: 'Peek-a-Boo Pattern Shop',
          from: 'amy@peekaboopatternshop.com',
          content: htmlContent
        }]
      })
    });

    if (!campaignResponse.ok) {
      const errorData = await campaignResponse.json();
      console.error('Campaign creation error:', errorData);
      return false;
    }

    const campaign = await campaignResponse.json();
    const campaignId = campaign.data.id;

    // Send to specific subscriber
    const sendResponse = await fetch(`https://connect.mailerlite.com/api/campaigns/${campaignId}/actions/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MAILERLITE_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        delivery: 'instant',
        recipient: {
          type: 'subscriber',
          email: toEmail
        }
      })
    });

    if (sendResponse.ok) {
      console.log(`Email sent to ${toEmail}: ${subject}`);
      return true;
    } else {
      const errorData = await sendResponse.json();
      console.error('Send error:', errorData);
      return false;
    }
  } catch (error) {
    console.error('Error sending email via MailerLite:', error);
    return false;
  }
}

// ===================
// ABANDONED CART PROCESSOR
// ===================
async function processAbandonedCarts() {
  console.log('Checking for abandoned carts...');
  
  try {
    const result = await pool.query(`
      SELECT * FROM abandoned_carts 
      WHERE customer_email IS NOT NULL 
        AND customer_email != ''
        AND converted = FALSE 
        AND email_sent_1 = FALSE
        AND updated_at < NOW() - INTERVAL '1 hour'
      ORDER BY updated_at ASC
      LIMIT 10
    `);

    console.log(`Found ${result.rows.length} abandoned carts to process`);

    for (const cart of result.rows) {
      const email = cart.customer_email;
      
      // Test mode check
      if (TEST_MODE && email.toLowerCase() !== TEST_EMAIL.toLowerCase()) {
        console.log(`TEST MODE: Skipping cart for ${email}`);
        continue;
      }

      console.log(`Processing cart ${cart.cart_id} for ${email}`);
      
      // Extract product info from cart
      const cartData = cart.cart_data;
      const lineItems = cartData.line_items || {};
      const allItems = [
        ...(lineItems.physical_items || []),
        ...(lineItems.digital_items || []),
        ...(lineItems.custom_items || [])
      ];
      
      const firstItem = allItems[0] || {};
      
      const product = {
        name: firstItem.name || 'Your items',
        image: firstItem.image_url || '',
        url: firstItem.url || 'https://www.peekaboopatternshop.com',
        price: (firstItem.sale_price || firstItem.list_price || 0).toFixed(2)
      };

      const subject = `Oops! You left ${product.name} in your cart`;
      const htmlContent = buildAbandonedCartEmail(null, product);
      
      const success = await sendEmailViaMailerLite(email, subject, htmlContent);
      
      if (success) {
        await pool.query(`
          UPDATE abandoned_carts 
          SET email_sent_1 = TRUE 
          WHERE id = $1
        `, [cart.id]);
        
        await pool.query(`
          INSERT INTO email_log (email_type, recipient_email, subject, cart_id)
          VALUES ('abandoned_cart_1', $1, $2, $3)
        `, [email, subject, cart.cart_id]);
        
        console.log(`Successfully sent abandoned cart email for ${cart.cart_id}`);
      }
    }
  } catch (error) {
    console.error('Error processing abandoned carts:', error);
  }
}

// ===================
// BROWSE ABANDONMENT PROCESSOR
// ===================
async function processBrowseAbandonment() {
  console.log('Checking for browse abandonment...');
  
  try {
    const result = await pool.query(`
      SELECT DISTINCT be.customer_email
      FROM browse_events be
      WHERE be.customer_email IS NOT NULL 
        AND be.customer_email != ''
        AND be.email_sent = FALSE
        AND be.viewed_at < NOW() - INTERVAL '2 hours'
        AND NOT EXISTS (
          SELECT 1 FROM abandoned_carts ac 
          WHERE ac.customer_email = be.customer_email 
            AND ac.converted = FALSE
            AND ac.updated_at > NOW() - INTERVAL '24 hours'
        )
      LIMIT 10
    `);

    console.log(`Found ${result.rows.length} browse abandonment emails to process`);

    for (const row of result.rows) {
      const email = row.customer_email;
      
      // Test mode check
      if (TEST_MODE && email.toLowerCase() !== TEST_EMAIL.toLowerCase()) {
        console.log(`TEST MODE: Skipping browse abandonment for ${email}`);
        continue;
      }

      const productsResult = await pool.query(`
        SELECT DISTINCT ON (product_id) 
          product_id, product_name, product_url, product_image, product_price, viewed_at
        FROM browse_events
        WHERE customer_email = $1 
          AND email_sent = FALSE
          AND viewed_at < NOW() - INTERVAL '2 hours'
        ORDER BY product_id, viewed_at DESC
      `, [email]);

      const products = productsResult.rows
        .sort((a, b) => new Date(b.viewed_at) - new Date(a.viewed_at))
        .slice(0, 3);

      if (products.length === 0) continue;

      console.log(`Processing browse abandonment for ${email} with ${products.length} products`);
      
      const subject = `Still thinking about ${products[0].product_name}?`;
      const htmlContent = buildBrowseAbandonmentEmail(null, products);
      
      const success = await sendEmailViaMailerLite(email, subject, htmlContent);
      
      if (success) {
        await pool.query(`
          UPDATE browse_events 
          SET email_sent = TRUE 
          WHERE customer_email = $1 AND email_sent = FALSE
        `, [email]);
        
        await pool.query(`
          INSERT INTO email_log (email_type, recipient_email, subject, product_id)
          VALUES ('browse_abandonment', $1, $2, $3)
        `, [email, subject, products[0].product_id]);
        
        console.log(`Successfully sent browse abandonment email for ${email}`);
      }
    }
  } catch (error) {
    console.error('Error processing browse abandonment:', error);
  }
}

// Run abandoned cart check every 5 minutes
cron.schedule('*/5 * * * *', () => {
  processAbandonedCarts();
});

// Run browse abandonment check every 10 minutes
cron.schedule('*/10 * * * *', () => {
  processBrowseAbandonment();
});

// ===================
// WEBHOOK ENDPOINTS
// ===================

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Abandoned Cart App is running',
    testMode: TEST_MODE,
    testEmail: TEST_MODE ? TEST_EMAIL : 'N/A'
  });
});

// BigCommerce webhook: Cart Created
app.post('/webhooks/cart-created', async (req, res) => {
  console.log('Cart created webhook received:', req.body);
  
  try {
    const cartId = req.body.data?.id || req.body.data?.cartId;
    if (!cartId) {
      return res.status(200).json({ received: true, note: 'No cart ID' });
    }

    const cart = await getCartDetails(cartId);
    if (!cart) {
      return res.status(200).json({ received: true, note: 'Could not fetch cart' });
    }

    let customerEmail = cart.email;
    if (!customerEmail && cart.customer_id) {
      customerEmail = await getCustomerEmail(cart.customer_id);
    }

    const cartTotal = cart.cart_amount || 0;

    await pool.query(`
      INSERT INTO abandoned_carts (cart_id, customer_email, customer_id, cart_data, cart_total, updated_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      ON CONFLICT (cart_id) 
      DO UPDATE SET 
        customer_email = COALESCE(EXCLUDED.customer_email, abandoned_carts.customer_email),
        customer_id = COALESCE(EXCLUDED.customer_id, abandoned_carts.customer_id),
        cart_data = EXCLUDED.cart_data,
        cart_total = EXCLUDED.cart_total,
        updated_at = CURRENT_TIMESTAMP
    `, [cartId, customerEmail, cart.customer_id, JSON.stringify(cart), cartTotal]);

    console.log(`Cart ${cartId} stored/updated. Email: ${customerEmail || 'unknown'}`);
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Error processing cart webhook:', error);
    res.status(200).json({ received: true, error: error.message });
  }
});

// BigCommerce webhook: Cart Updated
app.post('/webhooks/cart-updated', async (req, res) => {
  console.log('Cart updated webhook received:', req.body);
  
  try {
    const cartId = req.body.data?.id || req.body.data?.cartId;
    if (!cartId) {
      return res.status(200).json({ received: true, note: 'No cart ID' });
    }

    const cart = await getCartDetails(cartId);
    if (!cart) {
      return res.status(200).json({ received: true, note: 'Could not fetch cart' });
    }

    let customerEmail = cart.email;
    if (!customerEmail && cart.customer_id) {
      customerEmail = await getCustomerEmail(cart.customer_id);
    }

    const cartTotal = cart.cart_amount || 0;

    await pool.query(`
      INSERT INTO abandoned_carts (cart_id, customer_email, customer_id, cart_data, cart_total, updated_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      ON CONFLICT (cart_id) 
      DO UPDATE SET 
        customer_email = COALESCE(EXCLUDED.customer_email, abandoned_carts.customer_email),
        customer_id = COALESCE(EXCLUDED.customer_id, abandoned_carts.customer_id),
        cart_data = EXCLUDED.cart_data,
        cart_total = EXCLUDED.cart_total,
        updated_at = CURRENT_TIMESTAMP
    `, [cartId, customerEmail, cart.customer_id, JSON.stringify(cart), cartTotal]);

    console.log(`Cart ${cartId} updated. Email: ${customerEmail || 'unknown'}`);
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Error processing cart update webhook:', error);
    res.status(200).json({ received: true, error: error.message });
  }
});

// BigCommerce webhook: Order Created (marks cart as converted)
app.post('/webhooks/order-created', async (req, res) => {
  console.log('Order created webhook received:', req.body);
  
  try {
    const orderId = req.body.data?.id;
    const orderData = await fetchFromBigCommerce(`/v2/orders/${orderId}`);
    const cartId = orderData.cart_id;
    
    if (cartId) {
      await pool.query(`
        UPDATE abandoned_carts 
        SET converted = TRUE, updated_at = CURRENT_TIMESTAMP 
        WHERE cart_id = $1
      `, [cartId]);
      console.log(`Cart ${cartId} marked as converted (Order ${orderId})`);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Error processing order webhook:', error);
    res.status(200).json({ received: true, error: error.message });
  }
});

// Browse event endpoint
app.post('/track/product-view', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { sessionId, email, productId, productName, productUrl, productImage, productPrice } = req.body;
    
    if (!productId) {
      return res.status(400).json({ error: 'Product ID required' });
    }

    await pool.query(`
      INSERT INTO browse_events (session_id, customer_email, product_id, product_name, product_url, product_image, product_price)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [sessionId, email, productId, productName, productUrl, productImage, productPrice || 0]);

    console.log(`Product view tracked: ${productId} - ${productName} (${email || 'anonymous'})`);
    res.status(200).json({ tracked: true });
  } catch (error) {
    console.error('Error tracking product view:', error);
    res.status(200).json({ tracked: false, error: error.message });
  }
});

app.options('/track/product-view', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.status(200).end();
});

// Popup signup endpoint
app.post('/popup/signup', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email required' });
    }

    // Add to MailerLite Popup group
    const response = await fetch('https://connect.mailerlite.com/api/groups?filter[name]=' + encodeURIComponent('Peekaboo Website Popup'), {
      headers: {
        'Authorization': `Bearer ${MAILERLITE_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    const groupData = await response.json();
    const groupId = groupData.data?.[0]?.id;

    if (groupId) {
      await fetch('https://connect.mailerlite.com/api/subscribers', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${MAILERLITE_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          email: email,
          groups: [groupId]
        })
      });
      
      console.log(`Popup signup: ${email}`);
      res.status(200).json({ success: true });
    } else {
      res.status(200).json({ success: false, error: 'Group not found' });
    }
  } catch (error) {
    console.error('Error processing popup signup:', error);
    res.status(200).json({ success: false, error: error.message });
  }
});

app.options('/popup/signup', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.status(200).end();
});

// ===================
// API ENDPOINTS
// ===================

app.get('/api/abandoned-carts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM abandoned_carts 
      WHERE converted = FALSE 
      ORDER BY updated_at DESC 
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/browse-events', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM browse_events 
      ORDER BY viewed_at DESC 
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const cartStats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE converted = FALSE AND customer_email IS NOT NULL AND customer_email != '') as abandoned_with_email,
        COUNT(*) FILTER (WHERE converted = FALSE AND (customer_email IS NULL OR customer_email = '')) as abandoned_anonymous,
        COUNT(*) FILTER (WHERE converted = TRUE) as converted,
        COUNT(*) FILTER (WHERE email_sent_1 = TRUE) as cart_emails_sent
      FROM abandoned_carts
      WHERE created_at > NOW() - INTERVAL '30 days'
    `);
    
    const browseStats = await pool.query(`
      SELECT 
        COUNT(*) as total_views,
        COUNT(DISTINCT customer_email) FILTER (WHERE customer_email IS NOT NULL AND customer_email != '') as unique_visitors_with_email,
        COUNT(*) FILTER (WHERE email_sent = TRUE) as browse_emails_sent
      FROM browse_events
      WHERE viewed_at > NOW() - INTERVAL '30 days'
    `);
    
    res.json({
      carts: cartStats.rows[0],
      browse: browseStats.rows[0],
      testMode: TEST_MODE,
      testEmail: TEST_MODE ? TEST_EMAIL : 'N/A'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manual trigger for testing
app.post('/api/process-abandoned', async (req, res) => {
  try {
    await processAbandonedCarts();
    res.json({ success: true, message: 'Cart processing triggered', testMode: TEST_MODE });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/process-browse', async (req, res) => {
  try {
    await processBrowseAbandonment();
    res.json({ success: true, message: 'Browse processing triggered', testMode: TEST_MODE });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test email endpoint - send a test email immediately
app.post('/api/test-email', async (req, res) => {
  try {
    const { type } = req.body; // 'cart' or 'browse'
    
    if (type === 'cart') {
      const product = {
        name: 'Women\'s Sweatshirt Dress Pattern',
        image: 'https://cdn11.bigcommerce.com/s-m91f4azz/products/10307/images/57602/_43821__02557.1767096507.215.338.jpg',
        url: 'https://peekaboopatternshop.com/women-s-sweatshirt-dress-pattern/',
        price: '12.95'
      };
      
      const subject = `TEST: Oops! You left ${product.name} in your cart`;
      const html = buildAbandonedCartEmail(null, product);
      const success = await sendEmailViaMailerLite(TEST_EMAIL, subject, html);
      
      res.json({ success, message: success ? 'Test cart email sent' : 'Failed to send', testMode: TEST_MODE });
    } else if (type === 'browse') {
      const products = [
        { product_name: 'Wildflower Dress', product_image: 'https://cdn11.bigcommerce.com/s-m91f4azz/images/stencil/1280x1280/products/189/43834/_1174__26498.1765947170.jpg', product_url: 'https://www.peekaboopatternshop.com/wildflower-dress/' },
        { product_name: 'Alex & Anna Pajamas', product_image: 'https://cdn11.bigcommerce.com/s-m91f4azz/images/stencil/1280x1280/products/255/6498/Alex_and_Anna_pajamas_pattern__16653.1557262025.jpg', product_url: 'https://www.peekaboopatternshop.com/alex-anna-pajamas/' }
      ];
      
      const subject = `TEST: Still thinking about ${products[0].product_name}?`;
      const html = buildBrowseAbandonmentEmail('Jeremy', products);
      const success = await sendEmailViaMailerLite(TEST_EMAIL, subject, html);
      
      res.json({ success, message: success ? 'Test browse email sent' : 'Failed to send', testMode: TEST_MODE });
    } else {
      res.status(400).json({ error: 'Type must be "cart" or "browse"' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===================
// START SERVER
// ===================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`TEST MODE: ${TEST_MODE ? 'ON - Only sending to ' + TEST_EMAIL : 'OFF - Sending to all'}`);
  await initDatabase();
  console.log('Abandoned cart scheduler started - runs every 5 minutes');
  console.log('Browse abandonment scheduler started - runs every 10 minutes');
});
