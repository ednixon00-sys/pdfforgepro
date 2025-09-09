// In-memory license storage for development
// Replace with database in production

const { signLicenseToken } = require('./license.js');

class LicenseStore {
  constructor() {
    this.licenses = new Map(); // key -> { fullToken, license, metadata }
    this.paymentIntentIndex = new Map(); // paymentIntentId -> key
    this.subscriptionIndex = new Map(); // subscriptionId -> key
    
    // Initialize with development test licenses
    this.initializeDevelopmentLicenses();
  }

  initializeDevelopmentLicenses() {
    const devLicenses = [
      {
        key: 'PFW-DEV0-LIFE-TIME-TEST',
        license: {
          name: 'Development User',
          email: 'dev@example.com',
          plan: 'pro-lifetime',
          purchasedAt: '2024-01-01T00:00:00.000Z',
          expiresAt: null
        }
      },
      {
        key: 'PFW-DEV0-ANNU-AL00-TEST',
        license: {
          name: 'Development User',
          email: 'dev@example.com',
          plan: 'pro-annual',
          purchasedAt: '2024-01-01T00:00:00.000Z',
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
        }
      }
    ];

    devLicenses.forEach(({ key, license }) => {
      const fullToken = signLicenseToken(license);
      this.licenses.set(key, { fullToken, license, metadata: { isDevelopment: true } });
    });

    console.log('✅ Development license keys initialized:');
    console.log('   Lifetime: PFW-DEV0-LIFE-TIME-TEST');
    console.log('   Annual:   PFW-DEV0-ANNU-AL00-TEST');
  }

  storeLicense(key, fullToken, license, metadata = {}) {
    this.licenses.set(key, { fullToken, license, metadata });
    
    // Index by payment/subscription IDs for webhook handling
    if (metadata.paymentIntentId) {
      this.paymentIntentIndex.set(metadata.paymentIntentId, key);
    }
    if (metadata.subscriptionId) {
      this.subscriptionIndex.set(metadata.subscriptionId, key);
    }
    
    console.log(`📝 Stored license: ${key} (${license.plan})`);
  }

  getLicenseByKey(key) {
    return this.licenses.get(key) || null;
  }

  getLicenseByPaymentIntent(paymentIntentId) {
    const key = this.paymentIntentIndex.get(paymentIntentId);
    return key ? this.licenses.get(key) : null;
  }

  getLicenseBySubscription(subscriptionId) {
    const key = this.subscriptionIndex.get(subscriptionId);
    return key ? this.licenses.get(key) : null;
  }

  updateLicense(key, fullToken, license) {
    const existing = this.licenses.get(key);
    if (existing) {
      existing.fullToken = fullToken;
      existing.license = license;
      console.log(`📝 Updated license: ${key} (${license.plan})`);
    }
  }

  getAllLicenses() {
    const result = {};
    for (const [key, data] of this.licenses.entries()) {
      result[key] = {
        plan: data.license.plan,
        name: data.license.name,
        email: data.license.email,
        purchasedAt: data.license.purchasedAt,
        expiresAt: data.license.expiresAt,
        isDevelopment: data.metadata.isDevelopment || false
      };
    }
    return result;
  }
}

// Export singleton instance
module.exports = new LicenseStore();
