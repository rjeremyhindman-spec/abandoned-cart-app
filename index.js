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

// MailerLite API config
const MAILERLITE_API_KEY = process.env.MAILERLITE_API_KEY;
const MAILERLITE_GROUP_NAME = 'Jermeo Abandon Cart';

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
// MAILERLITE HELPERS
// ===================
async function getMailerLiteGroupId() {
  try {
    const response = await fetch('https://connect.mailerlite.com/api/groups?filter[name]=' + encodeURIComponent(MAILERLITE_GROUP_NAME), {
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
    console.error('MailerLite group not found:', MAILERLITE_GROUP_NAME);
    return null;
  } catch (error) {
    console.error('Error getting MailerLite group:', error);
    return null;
  }
}

async function addSubscriberToMailerLite(email, cartData) {
  try {
    const groupId = await getMailerLiteGroupId();
    if (!groupId) {
      console.error('Cannot add subscriber - group not found');
      return false;
    }

    // Extract product info from cart
    const lineItems = cartData.line_items || {};
    const allItems = [
      ...(lineItems.physical_items || []),
      ...(lineItems.digital_items || []),
      ...(lineItems.custom_items || [])
    ];
    
    const firstItem = allItems[0] || {};
    
    const subscriberData = {
      email: email,
      groups: [groupId],
      fields: {
        cart_product_name: firstItem.name || 'Your items',
        cart_product_image: firstItem.image_url || '',
        cart_product_url: firstItem.url || '',
        cart_product_price: firstItem.sale_price || firstItem.list_price || 0,
        cart_total: cartData.cart_amount || 0,
        cart_id: cartData.id || ''
      }
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
      console.log(`Added ${email} to MailerLite Abandoned Cart group`);
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

async function removeFromMailerLiteGroup(email) {
  try {
    const groupId = await getMailerLiteGroupId();
    if (!groupId) return false;

    // First get subscriber ID
    const searchResponse = await fetch(`https://connect.mailerlite.com/api/subscribers/${encodeURIComponent(email)}`, {
      headers: {
        'Authorization': `Bearer ${MAILERLITE_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    if (!searchResponse.ok) {
      console.log(`Subscriber ${email} not found in MailerLite`);
      return false;
    }

    const subscriber = await searchResponse.json();
    const subscriberId = subscriber.data?.id;

    if (!subscriberId) return false;

    // Remove from group
    const response = await fetch(`https://connect.mailerlite.com/api/subscribers/${subscriberId}/groups/${groupId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${MAILERLITE_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    if (response.ok) {
      console.log(`Removed ${email} from MailerLite Abandoned Cart group`);
      return true;
    }
  } catch (error) {
    console.error('Error removing from MailerLite:', error);
  }
  return false;
}

// ===================
// ABANDONED CART SCHEDULER
// ===================
async function processAbandonedCarts() {
  console.log('Checking for abandoned carts...');
  
  try {
    // Find carts that:
    // - Have an email
    // - Are not converted
    // - Haven't had first email sent
    // - Were updated more than 1 hour ago
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
      console.log(`Processing cart ${cart.cart_id} for ${cart.customer_email}`);
      
      const success = await addSubscriberToMailerLite(cart.customer_email, cart.cart_data);
      
      if (success) {
        // Mark as email sent
        await pool.query(`
          UPDATE abandoned_carts 
          SET email_sent_1 = TRUE 
          WHERE id = $1
        `, [cart.id]);
        
        // Log the email
        await pool.query(`
          INSERT INTO email_log (email_type, recipient_email, cart_id)
          VALUES ('abandoned_cart_1', $1, $2)
        `, [cart.customer_email, cart.cart_id]);
        
        console.log(`Successfully processed cart ${cart.cart_id}`);
      }
    }
  } catch (error) {
    console.error('Error processing abandoned carts:', error);
  }
}

// Run every 5 minutes
cron.schedule('*/5 * * * *', () => {
  processAbandonedCarts();
});

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
    const customerEmail = orderData.billing_address?.email;
    
    if (cartId) {
      await pool.query(`
        UPDATE abandoned_carts 
        SET converted = TRUE, updated_at = CURRENT_TIMESTAMP 
        WHERE cart_id = $1
      `, [cartId]);
      console.log(`Cart ${cartId} marked as converted (Order ${orderId})`);
    }

    // Remove from MailerLite abandoned cart group (stops the automation)
    if (customerEmail) {
      await removeFromMailerLiteGroup(customerEmail);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Error processing order webhook:', error);
    res.status(200).json({ received: true, error: error.message });
  }
});

// Browse event endpoint (called from storefront JavaScript)
app.post('/track/product-view', async (req, res) => {
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

app.options('/track/product-view', (req, res) => {
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

app.get('/api/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE converted = FALSE AND customer_email IS NOT NULL AND customer_email != '') as abandoned_with_email,
        COUNT(*) FILTER (WHERE converted = FALSE AND (customer_email IS NULL OR customer_email = '')) as abandoned_anonymous,
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

// Manual trigger for testing
app.post('/api/process-abandoned', async (req, res) => {
  try {
    await processAbandonedCarts();
    res.json({ success: true, message: 'Processing triggered' });
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
  console.log('Abandoned cart scheduler started - runs every 5 minutes');
});
