require("dotenv").config();

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const Razorpay = require("razorpay");

const app = express();
const PORT = process.env.PORT || 3000;

let razorpayClient = null;

/**
 * Lazily initializes and returns the Razorpay SDK instance using keys from .env.
 */
function getRazorpayClient() {
  if (razorpayClient) {
    return razorpayClient;
  }

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    return null;
  }

  razorpayClient = new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });

  return razorpayClient;
}

/**
 * Verifies a Razorpay HMAC SHA256 signature in constant time.
 *
 * @param {string | Buffer} payload - Exact string or raw request body bytes signed by Razorpay.
 * @param {string | undefined} signature - Hex-encoded HMAC signature received from Razorpay.
 * @param {string | undefined} secret - Razorpay key secret or webhook secret.
 * @returns {boolean} True if the signature matches; otherwise false.
 */
function verifyHmacSignature(payload, signature, secret) {
  if (!signature || !secret || typeof signature !== "string") {
    return false;
  }

  // Step 1: Compute the expected HMAC SHA256 digest as a lowercase hex string.
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  // Step 2: Convert both hex strings into Buffers of equal byte length.
  // crypto.timingSafeEqual throws if Buffer lengths do not match.
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const receivedBuffer = Buffer.from(signature, "utf8");

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  // Step 3: Compare the signatures using constant-time equality to prevent timing attacks.
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

/**
 * Webhook endpoint.
 * Registered BEFORE express.json() so express.raw() preserves the exact raw
 * request body bytes needed to verify the X-Razorpay-Signature header.
 */
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[Webhook] RAZORPAY_WEBHOOK_SECRET is not configured in .env");
    return res.status(500).json({ error: "Webhook secret is not configured." });
  }

  const signature = req.get("X-Razorpay-Signature");
  if (!Buffer.isBuffer(req.body)) {
    console.warn("[Webhook] Expected raw JSON request body.");
    return res.status(400).json({ error: "Invalid webhook payload." });
  }

  // Verify the raw body bytes against X-Razorpay-Signature using the webhook secret.
  const isValid = verifyHmacSignature(req.body, signature, webhookSecret);
  if (!isValid) {
    console.warn("[Webhook] Signature verification failed.");
    return res.status(400).json({ success: false, error: "Invalid webhook signature." });
  }

  try {
    const event = JSON.parse(req.body.toString("utf8"));
    const paymentEntity = event?.payload?.payment?.entity;

    console.log(`[Webhook] Verified event: ${event.event}`, {
      account_id: event.account_id,
      payment_id: paymentEntity?.id,
      order_id: paymentEntity?.order_id,
      amount: paymentEntity?.amount,
      status: paymentEntity?.status,
    });

    return res.status(200).json({ status: "ok" });
  } catch (err) {
    console.error("[Webhook] Failed to parse verified JSON body:", err.message);
    return res.status(400).json({ error: "Malformed JSON payload." });
  }
});

// Parse JSON bodies for all remaining routes and serve the static frontend.
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/**
 * Creates a Razorpay order for the requested amount in INR (rupees).
 */
app.post("/create-order", async (req, res) => {
  const { amount } = req.body || {};

  const parsedAmount = typeof amount === "number" ? amount : Number(amount);
  if (
    amount === undefined ||
    amount === null ||
    typeof amount === "boolean" ||
    !Number.isFinite(parsedAmount)
  ) {
    return res.status(400).json({ error: "Please provide a valid numeric amount in INR." });
  }

  // Razorpay expects amounts in the smallest currency unit (paise for INR).
  const amountInPaise = Math.round(parsedAmount * 100);
  if (amountInPaise < 100) {
    return res.status(400).json({ error: "Amount must be at least ₹1 (100 paise)." });
  }

  const client = getRazorpayClient();
  if (!client) {
    return res.status(500).json({
      error: "Razorpay keys are missing. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env.",
    });
  }

  try {
    const receipt = `rcpt_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const order = await client.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt,
    });

    return res.status(201).json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("[Create Order] Razorpay API error:", err);
    const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
    const message = err?.error?.description || "Failed to create Razorpay order.";
    return res.status(statusCode).json({ error: message });
  }
});

/**
 * Verifies the Razorpay Checkout callback signature.
 */
app.post("/verify-payment", (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};

  if (
    typeof razorpay_order_id !== "string" ||
    !razorpay_order_id.trim() ||
    typeof razorpay_payment_id !== "string" ||
    !razorpay_payment_id.trim() ||
    typeof razorpay_signature !== "string" ||
    !razorpay_signature.trim()
  ) {
    console.warn("[Verify Payment] Validation failed: missing required fields.");
    return res.status(400).json({
      success: false,
      error: "razorpay_order_id, razorpay_payment_id, and razorpay_signature are required.",
    });
  }

  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) {
    console.error("[Verify Payment] RAZORPAY_KEY_SECRET is not configured in .env");
    return res.status(500).json({
      success: false,
      error: "Razorpay key secret is not configured.",
    });
  }

  // Razorpay signs checkout callbacks using the string "order_id|payment_id".
  const signedPayload = `${razorpay_order_id}|${razorpay_payment_id}`;
  const isValid = verifyHmacSignature(signedPayload, razorpay_signature, keySecret);

  if (!isValid) {
    console.warn(
      `[Verify Payment] INVALID signature for order=${razorpay_order_id}, payment=${razorpay_payment_id}`
    );
    return res.status(400).json({ success: false });
  }

  console.log(
    `[Verify Payment] VALID signature for order=${razorpay_order_id}, payment=${razorpay_payment_id}`
  );
  return res.status(200).json({ success: true });
});

// Handle malformed JSON bodies cleanly.
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({ error: "Invalid JSON request body." });
  }
  return next(err);
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);

  const missingVars = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"].filter(
    (name) => !process.env[name]
  );
  if (missingVars.length > 0) {
    console.warn(
      `[Startup Notice] Missing environment variables in .env: ${missingVars.join(", ")}. Copy .env.example to .env and add your Razorpay test credentials.`
    );
  }
});

