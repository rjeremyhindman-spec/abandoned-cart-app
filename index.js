require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');

const app = express();
app.use(express.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// BigCommerce API config
const BC_STORE_HASH = process.env.BC_STORE_HASH;
const BC_ACCESS_TOKEN = process.env.BC_ACCESS_TOKEN;

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
// WEBHOOK ENDPOINTS
// ===================

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Abandoned Cart App is running' });
});

// BigCommerce webhook: Cart Created
app.post('/webhooks/cart-created', async (req, res) => {
  console.log('Cart created webhook received:', req.body);
  
  try {
    const cartId = req.body.data?.id || req.body.data?.cartId;
    if (!cartId) {
      return res.status(200).json({ received: true, note: 'No cart ID' });
    }

    // Fetch full cart details from BigCommerce
    const cart = await getCartDetails(cartId);
    if (!cart) {
      return res.status(200).json({ received: true, note: 'Could not fetch cart' });
    }

    // Try to get customer email
    let customerEmail = cart.email;
    if (!customerEmail && cart.customer_id) {
      customerEmail = await getCustomerEmail(cart.customer_id);
    }

    // Calculate cart total
    const cartTotal = cart.cart_amount || 0;

    // Store in database
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

// BigCommerce webhook: Cart Updated (same logic as created)
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
    
    // Fetch order to get the cart_id
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

// Browse event endpoint (called from storefront JavaScript)
app.post('/track/product-view', async (req, res) => {
  // Set CORS headers for storefront calls
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { sessionId, email, productId, productName, productUrl, productImage } = req.body;
    
    if (!productId) {
      return res.status(400).json({ error: 'Product ID required' });
    }

    await pool.query(`
      INSERT INTO browse_events (session_id, customer_email, product_id, product_name, product_url, product_image)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [sessionId, email, productId, productName, productUrl, productImage]);

    console.log(`Product view tracked: ${productId} (${email || 'anonymous'})`);
    res.status(200).json({ tracked: true });
  } catch (error) {
    console.error('Error tracking product view:', error);
    res.status(200).json({ tracked: false, error: error.message });
  }
});

// CORS preflight for tracking endpoint
app.options('/track/product-view', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.status(200).end();
});

// ===================
// API ENDPOINTS (for dashboard/debugging)
// ===================

// Get all abandoned carts
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

// Get stats
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE converted = FALSE AND customer_email IS NOT NULL) as abandoned_with_email,
        COUNT(*) FILTER (WHERE converted = FALSE AND customer_email IS NULL) as abandoned_anonymous,
        COUNT(*) FILTER (WHERE converted = TRUE) as converted,
        COUNT(*) FILTER (WHERE email_sent_1 = TRUE) as emails_sent
      FROM abandoned_carts
      WHERE created_at > NOW() - INTERVAL '30 days'
    `);
    res.json(stats.rows[0]);
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
  await initDatabase();
});
