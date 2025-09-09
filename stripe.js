const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Create Stripe subscription for annual plan
async function createStripeSubscription({ name, email, phone, billingAddress }) {
  try {
    // Create or get customer
    let customer;
    const existingCustomers = await stripe.customers.list({
      email: email,
      limit: 1,
    });

    if (existingCustomers.data.length > 0) {
      customer = existingCustomers.data[0];
    } else {
      customer = await stripe.customers.create({
        name,
        email,
        phone,
        address: billingAddress ? {
          line1: billingAddress.line1,
          line2: billingAddress.line2 || null,
          city: billingAddress.city,
          state: billingAddress.state,
          postal_code: billingAddress.postalCode,
          country: billingAddress.country || 'US',
        } : null,
      });
    }

    // Create subscription
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{
        price: process.env.STRIPE_PRICE_ID_YEARLY,
      }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        plan: 'annual',
        customerName: name,
        customerEmail: email
      }
    });

    return {
      ok: true,
      subscriptionId: subscription.id,
      clientSecret: subscription.latest_invoice.payment_intent.client_secret,
      customerId: customer.id
    };
  } catch (error) {
    console.error('Stripe subscription error:', error);
    return { ok: false, error: error.message };
  }
}

// Create Stripe payment intent for lifetime plan
async function createStripePaymentIntent({ amount, name, email, phone, billingAddress }) {
  try {
    // Create or get customer
    let customer;
    const existingCustomers = await stripe.customers.list({
      email: email,
      limit: 1,
    });

    if (existingCustomers.data.length > 0) {
      customer = existingCustomers.data[0];
    } else {
      customer = await stripe.customers.create({
        name,
        email,
        phone,
        address: billingAddress ? {
          line1: billingAddress.line1,
          line2: billingAddress.line2 || null,
          city: billingAddress.city,
          state: billingAddress.state,
          postal_code: billingAddress.postalCode,
          country: billingAddress.country || 'US',
        } : null,
      });
    }

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount, // Amount in cents
      currency: process.env.CURRENCY || 'USD',
      customer: customer.id,
      receipt_email: email,
      metadata: {
        plan: 'lifetime',
        name,
        email
      },
      description: 'PDF Forge Pro - Lifetime License'
    });

    return {
      ok: true,
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      customerId: customer.id
    };
  } catch (error) {
    console.error('Stripe payment intent error:', error);
    return { ok: false, error: error.message };
  }
}

// Verify Stripe payment
async function verifyStripePayment(type, id) {
  try {
    let paymentSucceeded = false;
    let customerInfo = {};

    if (type === 'payment_intent') {
      const paymentIntent = await stripe.paymentIntents.retrieve(id);
      paymentSucceeded = paymentIntent.status === 'succeeded';
      
      if (paymentSucceeded && paymentIntent.customer) {
        const customer = await stripe.customers.retrieve(paymentIntent.customer);
        customerInfo = {
          name: customer.name || paymentIntent.metadata?.name,
          email: customer.email || paymentIntent.metadata?.email
        };
      }
    } else if (type === 'subscription') {
      const subscription = await stripe.subscriptions.retrieve(id);
      paymentSucceeded = ['active', 'trialing'].includes(subscription.status);
      
      if (paymentSucceeded && subscription.customer) {
        const customer = await stripe.customers.retrieve(subscription.customer);
        customerInfo = {
          name: customer.name || subscription.metadata?.customerName,
          email: customer.email || subscription.metadata?.customerEmail
        };
      }
    }

    return {
      success: paymentSucceeded,
      customerInfo
    };
  } catch (error) {
    console.error('Stripe verification error:', error);
    return { success: false, error: error.message };
  }
}

// Helper to create annual price (run this once to set up)
async function createAnnualPrice(amountInCents) {
  try {
    // Create product
    const product = await stripe.products.create({
      name: 'PDF Forge Pro - Annual License',
      description: 'Annual subscription to PDF Forge Pro with all premium features',
    });

    // Create price
    const price = await stripe.prices.create({
      unit_amount: amountInCents,
      currency: 'usd',
      recurring: { interval: 'year' },
      product: product.id,
    });

    console.log('Created annual price:', price.id);
    return price;
  } catch (error) {
    console.error('Error creating annual price:', error);
    throw error;
  }
}

module.exports = {
  createStripeSubscription,
  createStripePaymentIntent,
  verifyStripePayment,
  createAnnualPrice
};
