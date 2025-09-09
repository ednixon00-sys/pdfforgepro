// api/server.js
// Minimal, host-friendly API for trial, license, and Stripe
const express = require("express");
const cors = require("cors");
const path = require("path");

// Local modules
const {
  verifyTrialToken,
  signTrialToken,
  verifyLicenseToken,
  signLicenseToken,
} = require("./license.js");
const {
  createStripeSubscription,
  createStripePaymentIntent,
  verifyStripePayment,
} = require("./stripe.js");
const store = require("./store.js");

const app = express();
const PORT = process.env.PORT || 5000;

// ------------------------------
// 0) CORS (allow your app domain)
// ------------------------------
app.use(
  cors({
    origin: true, // or set to ["https://systunepro.com", "app://."] if you want to lock down
    credentials: false,
  })
);

// ---------------------------------------------------------
// 1) Stripe webhook MUST be before express.json() middleware
// ---------------------------------------------------------
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
      const sig = req.headers["stripe-signature"];
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      } catch (err) {
        console.error("Webhook signature verification failed:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      // Handle the event
      switch (event.type) {
        case "payment_intent.succeeded":
          await handlePaymentIntentSucceeded(event.data.object);
          break;
        case "invoice.payment_succeeded":
          await handleInvoicePaymentSucceeded(event.data.object);
          break;
        case "customer.subscription.created":
        case "customer.subscription.updated":
          await handleSubscriptionChanged(event.data.object);
          break;
        case "customer.subscription.deleted":
          await handleSubscriptionDeleted(event.data.object);
          break;
        default:
          console.log(`Unhandled event type ${event.type}`);
      }

      res.json({ received: true });
    } catch (error) {
      console.error("Webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  }
);

// --------------------------------------------
// 2) JSON/body parsing for all other endpoints
// --------------------------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// --------------------------------------------
// 3) Basic env validation (warn if something is
//    missing; do not crash — easier for first run)
// --------------------------------------------
const requiredEnv = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "APP_SIGNING_SECRET",
  "STRIPE_PRICE_ID_YEARLY", // for annual plan
  // "STRIPE_WEBHOOK_SECRET" // recommended when using webhooks
];
const missing = requiredEnv.filter((k) => !process.env[k]);
if (missing.length) {
  console.warn(
    "⚠️  Missing environment variables:",
    missing.join(", "),
    "— some features may not work"
  );
}

// --------------------------------------------
// 4) Tiny in-memory rate limiter (per-IP)
//    Avoids ESM/CJS issues of express-rate-limit v7
// --------------------------------------------
function makeLimiter({ windowMs, max, message }) {
  const hits = new Map(); // ip -> { count, resetAt }
  return (req, res, next) => {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
    const now = Date.now();
    const entry = hits.get(ip);

    if (!entry || now > entry.resetAt) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= max) {
      return res.status(429).json({ ok: false, error: message });
    }

    entry.count++;
    next();
  };
}

const licenseLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many license requests, please try again later.",
});

const paymentLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Too many payment requests, please try again later.",
});

// -------------------
// 5) Utility endpoints
// -------------------

// Health/monitoring
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    time: new Date().toISOString(),
  });
});

// Stripe publishable key for client
app.get("/api/stripe/config", (req, res) => {
  res.json({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "pk_test_placeholder",
  });
});

// ----------------------
// 6) Trial API endpoints
// ----------------------

// Start trial
app.post("/api/trial/start", (req, res) => {
  try {
    const now = new Date();
    const trialDays = parseInt(process.env.APP_TRIAL_DAYS || "3", 10);
    const startedAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + trialDays * 24 * 60 * 60 * 1000
    ).toISOString();
    const secondsLeft = Math.max(
      0,
      Math.floor((new Date(expiresAt) - now) / 1000)
    );

    const trialToken = signTrialToken({ startedAt, durationDays: trialDays });

    res.json({
      ok: true,
      trialToken,
      startedAt,
      expiresAt,
      now: now.toISOString(),
      secondsLeft,
    });
  } catch (error) {
    console.error("Trial start error:", error);
    res.status(500).json({ ok: false, error: "Failed to start trial" });
  }
});

// Check trial status
app.get("/api/trial/status", (req, res) => {
  try {
    const { trialToken } = req.query;
    if (!trialToken || typeof trialToken !== "string") {
      return res.status(400).json({ ok: false, error: "Trial token required" });
    }

    const trial = verifyTrialToken(trialToken);
    const now = new Date();
    const expiresAt = new Date(
      new Date(trial.startedAt).getTime() +
        trial.durationDays * 24 * 60 * 60 * 1000
    );
    const secondsLeft = Math.max(0, Math.floor((expiresAt - now) / 1000));
    const expired = secondsLeft === 0;

    res.json({
      ok: true,
      trialToken,
      startedAt: trial.startedAt,
      expiresAt: expiresAt.toISOString(),
      now: now.toISOString(),
      secondsLeft,
      expired,
    });
  } catch (error) {
    console.error("Trial status error:", error);
    res.status(400).json({ ok: false, error: "Invalid trial token" });
  }
});

// -------------------------
// 7) License API endpoints
// -------------------------

// Verify license (by token or human-readable key)
app.post("/api/license/verify", licenseLimiter, (req, res) => {
  try {
    const { licenseKey } = req.body;
    if (!licenseKey) {
      return res.status(400).json({ ok: false, error: "License key required" });
    }

    let license;
    try {
      // Try JWT token first
      license = verifyLicenseToken(licenseKey);
    } catch {
      // Then try stored human-readable key
      const stored = store.getLicenseByKey(licenseKey);
      if (!stored) throw new Error("License not found");
      license = verifyLicenseToken(stored.fullToken);
    }

    res.json({
      ok: true,
      fullToken: signLicenseToken(license), // re-sign for freshness
      license,
    });
  } catch (error) {
    console.error("License verify error:", error);
    res.status(400).json({ ok: false, error: "Invalid license key" });
  }
});

// Redeem license key (return full token)
app.post("/api/license/redeem", licenseLimiter, (req, res) => {
  try {
    const { licenseKey } = req.body;
    if (!licenseKey) {
      return res.status(400).json({ ok: false, error: "License key required" });
    }

    const stored = store.getLicenseByKey(licenseKey);
    if (!stored) {
      return res.status(400).json({ ok: false, error: "Invalid license key" });
    }

    // Validate it’s still a good token
    verifyLicenseToken(stored.fullToken);

    res.json({ ok: true, fullToken: stored.fullToken });
  } catch (error) {
    console.error("License redeem error:", error);
    res.status(400).json({ ok: false, error: "Invalid license key" });
  }
});

// -------------------------
// 8) Payments API endpoints
// -------------------------

// Create payment/subscription
app.post("/api/payments/create", paymentLimiter, async (req, res) => {
  try {
    const { plan, name, email, phone, billingAddress } = req.body;

    if (!plan || !name || !email) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }
    if (!["annual", "lifetime"].includes(plan)) {
      return res.status(400).json({ ok: false, error: "Invalid plan" });
    }

    let result;
    if (plan === "annual") {
      result = await createStripeSubscription({ name, email, phone, billingAddress });
    } else {
      const lifetimeAmount = parseInt(process.env.LIFETIME_AMOUNT || "9999", 10);
      result = await createStripePaymentIntent({
        amount: lifetimeAmount,
        name,
        email,
        phone,
        billingAddress,
      });
    }

    res.json(result);
  } catch (error) {
    console.error("Payment create error:", error);
    res.status(500).json({ ok: false, error: "Failed to create payment" });
  }
});

// After payment, issue license
app.post("/api/payments/license", paymentLimiter, async (req, res) => {
  try {
    const { plan, paymentIntentId, subscriptionId } = req.body;

    if (!plan || !["annual", "lifetime"].includes(plan)) {
      return res.status(400).json({ ok: false, error: "Invalid plan" });
    }

    let paymentVerified = false;
    let customerInfo = {};

    if (plan === "lifetime" && paymentIntentId) {
      const verification = await verifyStripePayment("payment_intent", paymentIntentId);
      paymentVerified = verification.success;
      customerInfo = verification.customerInfo || {};
    } else if (plan === "annual" && subscriptionId) {
      const verification = await verifyStripePayment("subscription", subscriptionId);
      paymentVerified = verification.success;
      customerInfo = verification.customerInfo || {};
    }

    if (!paymentVerified) {
      return res.status(400).json({ ok: false, error: "Payment not verified" });
    }

    const now = new Date().toISOString();
    const license = {
      name: customerInfo.name || "Licensed User",
      email: customerInfo.email || "",
      plan: plan === "annual" ? "pro-annual" : "pro-lifetime",
      purchasedAt: now,
      expiresAt:
        plan === "annual"
          ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
          : null,
    };

    const fullToken = signLicenseToken(license);
    const licenseKey = generateLicenseKey();

    store.storeLicense(licenseKey, fullToken, license, {
      paymentIntentId: paymentIntentId || null,
      subscriptionId: subscriptionId || null,
    });

    res.json({
      ok: true,
      fullToken,
      licenseKey,
      licenseMeta: license,
    });
  } catch (error) {
    console.error("License creation error:", error);
    res.status(500).json({ ok: false, error: "Failed to create license" });
  }
});

// -------------------------
// 9) Helpers
// -------------------------
function generateLicenseKey() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const segments = [];
  for (let i = 0; i < 5; i++) {
    let seg = "";
    for (let j = 0; j < 4; j++) {
      seg += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    segments.push(seg);
  }
  return `PFW-${segments.join("-")}`;
}

async function handlePaymentIntentSucceeded(paymentIntent) {
  const existing = store.getLicenseByPaymentIntent(paymentIntent.id);
  if (existing) return;

  const license = {
    name: paymentIntent.metadata?.name || "Licensed User",
    email: paymentIntent.metadata?.email || "",
    plan: "pro-lifetime",
    purchasedAt: new Date().toISOString(),
    expiresAt: null,
  };

  const fullToken = signLicenseToken(license);
  const licenseKey = generateLicenseKey();

  store.storeLicense(licenseKey, fullToken, license, {
    paymentIntentId: paymentIntent.id,
  });
}

async function handleInvoicePaymentSucceeded(invoice) {
  const subscriptionId = invoice.subscription;
  if (!subscriptionId) return;

  const existing = store.getLicenseBySubscription(subscriptionId);
  if (existing) return;

  const license = {
    name: invoice.customer_name || "Licensed User",
    email: invoice.customer_email || "",
    plan: "pro-annual",
    purchasedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  };

  const fullToken = signLicenseToken(license);
  const licenseKey = generateLicenseKey();

  store.storeLicense(licenseKey, fullToken, license, { subscriptionId });
}

async function handleSubscriptionChanged(subscription) {
  const existing = store.getLicenseBySubscription(subscription.id);
  if (!existing) return;

  if (subscription.status === "active") {
    const updated = {
      ...existing.license,
      expiresAt: new Date(subscription.current_period_end * 1000).toISOString(),
    };
    const newToken = signLicenseToken(updated);
    store.updateLicense(existing.key, newToken, updated);
  }
}

async function handleSubscriptionDeleted(subscription) {
  const existing = store.getLicenseBySubscription(subscription.id);
  if (!existing) return;

  const updated = {
    ...existing.license,
    expiresAt: new Date().toISOString(),
  };
  const newToken = signLicenseToken(updated);
  store.updateLicense(existing.key, newToken, updated);
}

// -------------------------
// 10) Start the server
// -------------------------
app.get("/", (req, res) => {
  res.send("PDFForgePro API is running. Try /health or /api/stripe/config");
});
app.listen(PORT, "0.0.0.0", () => {
  console.log(` PDF Forge Trial API listening on ${PORT}`);
  console.log(` Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(` Trial days: ${process.env.APP_TRIAL_DAYS || "3"}`);
});
