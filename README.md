# Razorpay Test Mode Backend (Node.js + Express)

A minimal backend and single-page checkout demo integrating **Razorpay** in **Test Mode**.

## Project Structure

```text
.
├── public/
│   └── index.html     # Minimal checkout UI using Razorpay checkout.js
├── .env.example       # Template for Razorpay environment variables
├── .gitignore         # Ignores node_modules and .env
├── package.json       # Dependencies and start script
├── README.md          # Setup, testing, and signature verification guide
└── server.js          # Express server with order, verification, and webhook routes
```

## 1. Getting Test Keys from Razorpay Dashboard

1. Sign in to the [Razorpay Dashboard](https://dashboard.razorpay.com/).
2. Switch the toggle in the top menu to **Test Mode**.
3. Go to **Account & Settings** → **API Keys** → **Generate Test Key**.
4. Copy the **Key ID** (`rzp_test_...`) and **Key Secret**.
5. *(Optional, for webhooks)* Go to **Account & Settings** → **Webhooks** → **Add New Webhook**, set your webhook secret, and subscribe to events such as `payment.captured`.

## 2. Setup & Run

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create your `.env` file from `.env.example`:
   ```bash
   cp .env.example .env
   ```
3. Fill in your Razorpay credentials in `.env`:
   ```env
   PORT=3000
   RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxx
   RAZORPAY_KEY_SECRET=your_test_key_secret
   RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
   ```
4. Start the server:
   ```bash
   npm start
   ```
5. Open `http://localhost:3000` in your browser.

## 3. Testing End-to-End with Razorpay Test Mode

1. Enter an amount in INR (for example `100`) and click **Pay Now**.
2. Razorpay Checkout opens in Test Mode. Use one of Razorpay's official test payment methods:
   - **Test UPI:** Enter `success@razorpay` to simulate a successful UPI payment (or `failure@razorpay` to simulate a failure).
   - **Test Card:** Select **Card** and use a Razorpay test card such as `4111 1111 1111 1111` or `4718 6091 0820 4366` (Visa Domestic) with any valid future expiry date and any 3-digit CVV, then approve on the simulated OTP screen. See the [Razorpay Test Cards documentation](https://razorpay.com/docs/payments/payments/test-card-details/) for additional cards.
3. On completion, the frontend sends `razorpay_order_id`, `razorpay_payment_id`, and `razorpay_signature` to `POST /verify-payment` and displays the verification result.

### Testing Webhooks Locally (Optional)

Razorpay webhooks require a publicly reachable HTTPS URL:
1. Expose your local server using a tunnel (e.g., `ngrok http 3000`).
2. Add `https://<your-tunnel-domain>/webhook` in the Razorpay Dashboard under **Webhooks** with `payment.captured` enabled and your `RAZORPAY_WEBHOOK_SECRET`.
3. Complete a test payment and check your server terminal for `[Webhook] Verified event: payment.captured`.

## 4. How Signature Verification Works

Razorpay prevents tampering with payment responses and webhook payloads using **HMAC SHA256** signatures:

1. **Checkout Callback (`POST /verify-payment`)**
   - After checkout succeeds, Razorpay gives the browser `razorpay_order_id`, `razorpay_payment_id`, and `razorpay_signature`.
   - The backend concatenates `order_id` and `payment_id` with a pipe (`"${razorpay_order_id}|${razorpay_payment_id}"`), computes its HMAC SHA256 hex digest using `RAZORPAY_KEY_SECRET`, and compares it to `razorpay_signature` using `crypto.timingSafeEqual`.
   - Because only your backend and Razorpay know `RAZORPAY_KEY_SECRET`, a valid signature proves the payment confirmation came from Razorpay for that exact order.

2. **Webhook (`POST /webhook`)**
   - Razorpay signs the exact **raw JSON request body** with `RAZORPAY_WEBHOOK_SECRET` and sends the hex digest in the `X-Razorpay-Signature` header.
   - `POST /webhook` uses `express.raw({ type: "application/json" })` *before* `express.json()` so the original bytes are preserved intact for HMAC SHA256 verification and constant-time comparison (`crypto.timingSafeEqual`).
