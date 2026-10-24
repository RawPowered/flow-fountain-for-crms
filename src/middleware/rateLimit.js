const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const skipOptions = (req) => req.method === 'OPTIONS';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // SP-04: strict lockout limit
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
  skip: skipOptions,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const username = String(req.body?.username || '').trim().toLowerCase();
    return username ? `user:${username}` : `ip:${ipKeyGenerator(req.ip)}`;
  },
});

/** Per-IP limit for machine API (before/around auth). */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded' },
  skip: skipOptions,
});

const installLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many install attempts' },
  skip: skipOptions,
});

module.exports = {
  loginLimiter,
  apiLimiter,
  installLimiter,
};
