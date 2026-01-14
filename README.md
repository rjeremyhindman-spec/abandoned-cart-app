# Abandoned Cart & Browse Abandonment App

Custom email automation for BigCommerce stores.

## Features

- **Abandoned Cart Tracking**: Captures cart data via BigCommerce webhooks
- **Browse Abandonment Tracking**: JavaScript tracker for product page views
- **Conversion Tracking**: Automatically marks carts as converted when orders are placed
- **Email Automation**: Scheduled emails for abandoned carts (Phase 2)

## Setup

### 1. Deploy to Railway

1. Push this code to a GitHub repo
2. In Railway, click "New Project" → "Deploy from GitHub repo"
3. Add a PostgreSQL database: Click "New" → "Database" → "PostgreSQL"
4. Railway will automatically set `DATABASE_URL`

### 2. Set Environment Variables

In Railway, go to your app → Variables tab and add:

```
BC_STORE_HASH=your_store_hash
BC_ACCESS_TOKEN=your_access_token
BC_CLIENT_ID=your_client_id
```

### 3. Set Up BigCommerce Webhooks

In BigCommerce Admin → Settings → API → Webhooks, create:

| Event | Destination URL |
|-------|-----------------|
| store/cart/created | https://your-app.railway.app/webhooks/cart-created |
| store/cart/updated | https://your-app.railway.app/webhooks/cart-updated |
| store/order/created | https://your-app.railway.app/webhooks/order-created |

### 4. Add Storefront Tracking Script (for browse abandonment)

Add this to your BigCommerce theme's footer:

```html
<script>
(function() {
  // Only run on product pages
  if (!document.querySelector('[data-product-id]')) return;
  
  var productId = document.querySelector('[data-product-id]').dataset.productId;
  var productName = document.querySelector('h1.productView-title')?.innerText;
  var productImage = document.querySelector('.productView-image img')?.src;
  
  // Get or create session ID
  var sessionId = localStorage.getItem('browse_session') || 
    'session_' + Math.random().toString(36).substr(2, 9);
  localStorage.setItem('browse_session', sessionId);
  
  // Get email if known (from cookie or localStorage)
  var email = localStorage.getItem('customer_email') || null;
  
  fetch('https://your-app.railway.app/track/product-view', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: sessionId,
      email: email,
      productId: productId,
      productName: productName,
      productUrl: window.location.href,
      productImage: productImage
    })
  });
})();
</script>
```

## API Endpoints

- `GET /` - Health check
- `GET /api/abandoned-carts` - List abandoned carts
- `GET /api/stats` - Dashboard statistics
- `POST /webhooks/cart-created` - BigCommerce webhook
- `POST /webhooks/cart-updated` - BigCommerce webhook
- `POST /webhooks/order-created` - BigCommerce webhook
- `POST /track/product-view` - Storefront product view tracking

## Phase 2: Email Sending

Coming next:
- SendGrid/Postmark integration
- Scheduled email jobs
- Email templates
- Unsubscribe handling
