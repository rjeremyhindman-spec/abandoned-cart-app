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

// Placeholder image if product image not found
const PLACEHOLDER_IMAGE = 'https://cdn11.bigcommerce.com/s-m91f4azz/images/stencil/original/image-manager/untitled-design-5-.png?t=1768433349';

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

// Update BigCommerce cart with customer email
async function updateCartEmail(cartId, email) {
  try {
    const response = await fetch(`https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/carts/${cartId}`, {
      method: 'PUT',
      headers: {
        'X-Auth-Token': BC_ACCESS_TOKEN,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        customer_id: 0,
        email: email
      })
    });
    
    if (response.ok) {
      console.log(`Updated BigCommerce cart ${cartId} with email: ${email}`);
      return true;
    } else {
      const errorText = await response.text();
      console.error(`Failed to update cart ${cartId}:`, errorText);
      return false;
    }
  } catch (error) {
    console.error('Error updating cart email:', error);
    return false;
  }
}

// Get most recent cart ID from our database (created in last 30 minutes without email)
async function getRecentCartWithoutEmail() {
  try {
    const result = await pool.query(`
      SELECT cart_id FROM abandoned_carts 
      WHERE (customer_email IS NULL OR customer_email = '')
        AND converted = FALSE
        AND updated_at > NOW() - INTERVAL '30 minutes'
      ORDER BY updated_at DESC 
      LIMIT 1
    `);
    
    if (result.rows.length > 0) {
      return result.rows[0].cart_id;
    }
    return null;
  } catch (error) {
    console.error('Error getting recent cart:', error);
    return null;
  }
}

// ===================
// IMAGE REDIRECT ENDPOINTS (for MailerLite)
// ===================

// Cart product image redirect
app.get('/cart-image', async (req, res) => {
  try {
    const email = req.query.email;
    
    if (!email) {
      return res.redirect(PLACEHOLDER_IMAGE);
    }

    const result = await pool.query(`
      SELECT cart_data FROM abandoned_carts 
      WHERE customer_email = $1 
        AND converted = FALSE
      ORDER BY updated_at DESC 
      LIMIT 1
    `, [email]);

    if (result.rows.length === 0) {
      return res.redirect(PLACEHOLDER_IMAGE);
    }

    const cartData = result.rows[0].cart_data;
    const lineItems = cartData.line_items || {};
    const allItems = [
      ...(lineItems.physical_items || []),
      ...(lineItems.digital_items || []),
      ...(lineItems.custom_items || [])
    ];
    
    const firstItem = allItems[0];
    
    if (firstItem && firstItem.image_url) {
      return res.redirect(firstItem.image_url);
    }
    
    res.redirect(PLACEHOLDER_IMAGE);
  } catch (error) {
    console.error('Error in cart-image redirect:', error);
    res.redirect(PLACEHOLDER_IMAGE);
  }
});

// Browse product image redirect (supports product 1, 2, or 3)
app.get('/browse-image', async (req, res) => {
  try {
    const email = req.query.email;
    const productNum = parseInt(req.query.product) || 1; // 1, 2, or 3
    
    if (!email) {
      return res.redirect(PLACEHOLDER_IMAGE);
    }

    const result = await pool.query(`
      SELECT DISTINCT ON (product_id) 
        product_id, product_name, product_url, product_image, viewed_at
      FROM browse_events
      WHERE customer_email = $1
        AND product_image IS NOT NULL
        AND product_image != ''
      ORDER BY product_id, viewed_at DESC
    `, [email]);

    // Sort by most recent and get the requested product
    const products = result.rows
      .sort((a, b) => new Date(b.viewed_at) - new Date(a.viewed_at))
      .slice(0, 3);

    const product = products[productNum - 1];
    
    if (product && product.product_image) {
      return res.redirect(product.product_image);
    }
    
    res.redirect(PLACEHOLDER_IMAGE);
  } catch (error) {
    console.error('Error in browse-image redirect:', error);
    res.redirect(PLACEHOLDER_IMAGE);
  }
});

// ===================
// MAILERLITE HELPERS
// ===================
async function getMailerLiteGroupId(groupName) {
  try {
    const response = await fetch('https://connect.mailerlite.com/api/groups?filter[name]=' + encodeURIComponent(groupName), {
      headers: {
        'Authorization': `Bearer ${MAILERLITE_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    const data = await response.json();
    if (data.data && data.data.length > 0) {
      return data.data[0].id;
    }
    console.error('MailerLite group not found:', groupName);
    return null;
  } catch (error) {
    console.error('Error getting MailerLite group:', error);
    return null;
  }
}

async function addSubscriberToMailerLite(email, groupName, fields = {}) {
  try {
    const groupId = await getMailerLiteGroupId(groupName);
    if (!groupId) {
      console.error('Cannot add subscriber - group not found');
      return false;
    }

    const subscriberData = {
      email: email,
      groups: [groupId],
      fields: fields
    };

    const response = await fetch('https://connect.mailerlite.com/api/subscribers', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MAILERLITE_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(subscriberData)
    });

    const result = await response.json();
    
    if (response.ok) {
      console.log(`Added ${email} to MailerLite group: ${groupName}`);
      return true;
    } else {
      console.error('MailerLite error:', result);
      return false;
    }
  } catch (error) {
    console.error('Error adding to MailerLite:', error);
    return false;
  }
}

// ===================
// BROWSE ABANDONMENT PROCESSOR
// ===================
async function processBrowseAbandonment() {
  console.log('Checking for browse abandonment...');
  
  try {
    // Find emails with browse events that:
    // - Have an email
    // - Were viewed more than 2 hours ago
    // - Haven't been sent a browse email yet
    // - Do NOT have an active abandoned cart (so BigCommerce handles those)
    const result = await pool.query(`
      SELECT DISTINCT be.customer_email
      FROM browse_events be
      WHERE be.customer_email IS NOT NULL 
        AND be.customer_email != ''
        AND be.email_sent = FALSE
        AND be.viewed_at < NOW() - INTERVAL '2 hours'
        AND be.product_image IS NOT NULL
        AND be.product_image != ''
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

      // Get products with images only
      const productsResult = await pool.query(`
        SELECT DISTINCT ON (product_id) 
          product_id, product_name, product_url, product_image, product_price, viewed_at
        FROM browse_events
        WHERE customer_email = $1 
          AND email_sent = FALSE
          AND viewed_at < NOW() - INTERVAL '2 hours'
          AND product_image IS NOT NULL
          AND product_image != ''
        ORDER BY product_id, viewed_at DESC
      `, [email]);

      const products = productsResult.rows
        .sort((a, b) => new Date(b.viewed_at) - new Date(a.viewed_at))
        .slice(0, 2); // Get top 2 most recent products

      if (products.length === 0) {
        console.log(`No products with images for ${email}, skipping`);
        continue;
      }

      console.log(`Processing browse abandonment for ${email} with ${products.length} products`);
      
      // Build fields for MailerLite
      const fields = {
        browse_product_count: products.length,
        browse_product_1_name: products[0]?.product_name || '',
        browse_product_1_url: products[0]?.product_url || '',
        browse_product_1_price: products[0]?.product_price || 0,
        browse_product_2_name: products[1]?.product_name || '',
        browse_product_2_url: products[1]?.product_url || '',
        browse_product_2_price: products[1]?.product_price || 0
      };
      
      const success = await addSubscriberToMailerLite(email, 'Peekaboo Browse Abandonment', fields);
      
      if (success) {
        await pool.query(`
          UPDATE browse_events 
          SET email_sent = TRUE 
          WHERE customer_email = $1 AND email_sent = FALSE
        `, [email]);
        
        await pool.query(`
          INSERT INTO email_log (email_type, recipient_email, product_id)
          VALUES ('browse_abandonment', $1, $2)
        `, [email, products[0].product_id]);
        
        console.log(`Successfully processed browse abandonment for ${email}`);
      }
    }
  } catch (error) {
    console.error('Error processing browse abandonment:', error);
  }
}

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
    message: 'Peek-a-Boo Tracking App',
    testMode: TEST_MODE,
    testEmail: TEST_MODE ? TEST_EMAIL : 'N/A',
    features: [
      'Browse abandonment emails via MailerLite',
      'Cart tracking for BigCommerce abandoned cart emails',
      'Popup email capture syncs to BigCommerce carts'
    ]
  });
});

// BigCommerce webhook: Cart Created
app.post('/webhooks/cart-created', async (req, res) => {
  console.log('Cart created webhook received');
  
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

    console.log(`Cart ${cartId} tracked. Email: ${customerEmail || 'unknown'}`);
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Error processing cart webhook:', error);
    res.status(200).json({ received: true, error: error.message });
  }
});

// BigCommerce webhook: Cart Updated
app.post('/webhooks/cart-updated', async (req, res) => {
  console.log('Cart updated webhook received');
  
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
  console.log('Order created webhook received');
  
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

// ===================
// ADD TO CART TRACKING (syncs popup email to BigCommerce cart)
// ===================
app.post('/track/add-to-cart', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(200).json({ success: false, error: 'No email provided' });
    }

    console.log(`Add-to-cart detected for email: ${email}`);

    // Find the most recent cart without an email (created in last 30 min)
    const cartId = await getRecentCartWithoutEmail();
    
    if (!cartId) {
      console.log('No recent cart without email found');
      return res.status(200).json({ success: false, error: 'No recent cart to update' });
    }

    // Update the BigCommerce cart with this email
    const updated = await updateCartEmail(cartId, email);
    
    if (updated) {
      // Also update our database
      await pool.query(`
        UPDATE abandoned_carts 
        SET customer_email = $1, updated_at = CURRENT_TIMESTAMP 
        WHERE cart_id = $2
      `, [email, cartId]);
      
      console.log(`Successfully linked email ${email} to cart ${cartId}`);
      return res.status(200).json({ success: true, cartId: cartId });
    } else {
      return res.status(200).json({ success: false, error: 'Failed to update BigCommerce cart' });
    }
  } catch (error) {
    console.error('Error in add-to-cart tracking:', error);
    res.status(200).json({ success: false, error: error.message });
  }
});

app.options('/track/add-to-cart', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.status(200).end();
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

    const success = await addSubscriberToMailerLite(email, 'Peekaboo Website Popup', {});
    
    if (success) {
      console.log(`Popup signup: ${email}`);
      res.status(200).json({ success: true });
    } else {
      res.status(200).json({ success: false, error: 'Could not add to list' });
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
        COUNT(*) FILTER (WHERE converted = TRUE) as converted
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
app.post('/api/process-browse', async (req, res) => {
  try {
    await processBrowseAbandonment();
    res.json({ success: true, message: 'Browse processing triggered', testMode: TEST_MODE });
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
  console.log('Features:');
  console.log('  - Browse abandonment emails (via MailerLite)');
  console.log('  - Cart tracking (for BigCommerce abandoned cart emails)');
  console.log('  - Popup email → BigCommerce cart sync');
  await initDatabase();
  console.log('Browse abandonment scheduler started - runs every 10 minutes');
});
