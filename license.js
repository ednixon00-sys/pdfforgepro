const jwt = require('jsonwebtoken');

const SECRET = process.env.APP_SIGNING_SECRET || 'fallback-dev-secret-please-change-in-production';

// Trial token functions
function signTrialToken(payload) {
  return jwt.sign({
    ...payload,
    type: 'trial',
    iat: Math.floor(Date.now() / 1000)
  }, SECRET, { 
    expiresIn: '7d' // Trial tokens expire after 7 days for cleanup
  });
}

function verifyTrialToken(token) {
  const decoded = jwt.verify(token, SECRET);
  
  if (decoded.type !== 'trial') {
    throw new Error('Invalid trial token type');
  }
  
  return {
    startedAt: decoded.startedAt,
    durationDays: decoded.durationDays
  };
}

// License token functions  
function signLicenseToken(payload) {
  return jwt.sign({
    ...payload,
    type: 'license',
    iat: Math.floor(Date.now() / 1000)
  }, SECRET, {
    // Lifetime licenses don't expire, annual licenses expire when specified
    ...(payload.expiresAt ? { expiresIn: Math.floor((new Date(payload.expiresAt) - new Date()) / 1000) } : {})
  });
}

function verifyLicenseToken(token) {
  const decoded = jwt.verify(token, SECRET);
  
  if (decoded.type !== 'license') {
    throw new Error('Invalid license token type');
  }
  
  // Check if license has expired (for annual licenses)
  if (decoded.expiresAt) {
    const expiry = new Date(decoded.expiresAt);
    if (expiry < new Date()) {
      throw new Error('License has expired');
    }
  }
  
  return {
    name: decoded.name,
    email: decoded.email,
    plan: decoded.plan,
    purchasedAt: decoded.purchasedAt,
    expiresAt: decoded.expiresAt
  };
}

module.exports = {
  signTrialToken,
  verifyTrialToken,
  signLicenseToken,
  verifyLicenseToken
};
