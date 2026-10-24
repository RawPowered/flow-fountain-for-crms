const assert = require('assert/strict');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { getGoogleOAuthConfig } = require('../src/config');
const {
  createAuthorizationRequest,
  validateOAuthIntent,
  exchangeGoogleCode,
  bindGoogleIdentity,
  oauthError,
  OAUTH_INTENT_TTL_MS,
} = require('../src/services/googleAdminMfa');
const { createAuthRouter } = require('../src/routes/auth');
const { isAdminSessionAuthenticated } = require('../src/middleware/sessionAuth');

async function run() {
  const original = Object.fromEntries([
    'ADMIN_BASE_PATH', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REDIRECT_URI', 'GOOGLE_OAUTH_ALLOWED_EMAILS', 'ADMIN_MFA_REQUIRED',
  ].map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    ADMIN_BASE_PATH: '/p/mfa-test-path',
    GOOGLE_OAUTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_OAUTH_REDIRECT_URI: 'https://api.example.invalid/p/mfa-test-path/auth/google/callback',
    GOOGLE_OAUTH_ALLOWED_EMAILS: 'owner@example.com, steward@example.com',
    ADMIN_MFA_REQUIRED: 'true',
  });
  try {
    const config = getGoogleOAuthConfig();
    assert.equal(config.configured, true);
    assert.equal(config.required, true);
    assert.deepEqual(config.allowedEmails, ['owner@example.com', 'steward@example.com']);
    assert.equal(isAdminSessionAuthenticated({ id: 'root-1' }, config), false);
    const verifiedAt = new Date().toISOString();
    assert.equal(isAdminSessionAuthenticated({
      id: 'root-1', mfa: { provider: 'google', verifiedAt },
    }, config), true);
    assert.equal(isAdminSessionAuthenticated({
      id: 'root-1', mfa: { provider: 'google', verifiedAt },
    }, config, Date.now() + config.sessionHours * 3600000 + 1), false);

    const request = createAuthorizationRequest(config);
    const authorizationUrl = new URL(request.url);
    assert.equal(authorizationUrl.origin, 'https://accounts.google.com');
    assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorizationUrl.searchParams.get('scope'), 'openid email');
    assert.equal(validateOAuthIntent(request.intent, request.intent.state), true);
    assert.equal(validateOAuthIntent(request.intent, request.intent.state,
      request.intent.createdAt + OAUTH_INTENT_TTL_MS + 1), false);
    assert.equal(validateOAuthIntent(request.intent, 'wrong-state'), false);

    const upstreamCalls = [];
    const identity = await exchangeGoogleCode('authorization-code', 'pkce-verifier', config,
      async (url, options) => {
        upstreamCalls.push({ url, options });
        if (url.includes('/token')) {
          return new Response(JSON.stringify({ access_token: 'access-token', token_type: 'Bearer' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          sub: 'google-subject-1', email: 'owner@example.com', email_verified: true,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
    assert.deepEqual(identity, {
      provider: 'google', subject: 'google-subject-1', email: 'owner@example.com',
    });
    assert.match(upstreamCalls[0].options.body, /code_verifier=pkce-verifier/);
    assert.equal(upstreamCalls[1].options.headers.Authorization, 'Bearer access-token');

    const writes = [];
    const bindingPool = {
      async getConnection() {
        return {
          async beginTransaction() {},
          async query(sql, params) {
            writes.push({ sql, params });
            if (sql.includes('FROM admin_mfa_identities')) return [[]];
            return [{ affectedRows: 1 }];
          },
          async commit() {}, async rollback() {}, release() {},
        };
      },
    };
    const bound = await bindGoogleIdentity({
      id: 'root-1', username: 'owner', email: 'owner@example.com', principalType: 'root',
    }, identity, config, bindingPool);
    assert.equal(bound.enrolled, true);
    assert.equal(writes.some((item) => item.sql.includes('INSERT INTO admin_mfa_identities')), true);
    await assert.rejects(
      bindGoogleIdentity({
        id: 'root-1', username: 'owner', email: 'owner@example.com', principalType: 'root',
      }, { subject: 'google-subject-2', email: 'steward@example.com' }, config, bindingPool),
      (error) => error.status === 403
    );

    await testAuthFlow(config);
    console.log('Admin Google MFA tests passed');
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function testAuthFlow(config) {
  const admin = {
    id: 'root-1', username: 'owner', email: 'owner@example.com',
    role: 'root_owner', principalType: 'root', apiKeyId: null,
  };
  const oauth = {
    createAuthorizationRequest() {
      return {
        url: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixed-state',
        intent: { state: 'fixed-state', verifier: 'fixed-verifier', createdAt: Date.now() },
      };
    },
    validateOAuthIntent(intent, state) { return intent?.state === state; },
    async exchangeGoogleCode(code, verifier) {
      assert.equal(code, 'test-code');
      assert.equal(verifier, 'fixed-verifier');
      return { provider: 'google', subject: 'google-subject-1', email: 'owner@example.com' };
    },
    async bindGoogleIdentity() {
      return { provider: 'google', subject: 'google-subject-1', email: 'owner@example.com', enrolled: true };
    },
    oauthError,
  };
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'admin-mfa-test-secret', resave: false, saveUninitialized: false }));
  app.use('/p/mfa-test-path', createAuthRouter({
    verifyPassword: async (username, password) => username === 'owner' && password === 'Password123' ? admin : null,
    findPrincipalById: async () => admin,
    googleMfa: oauth,
    getGoogleOAuthConfig: () => config,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const passwordResponse = await fetch(`${origin}/p/mfa-test-path/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'Password123', next: '/p/mfa-test-path/owl' }),
    });
    assert.equal(passwordResponse.status, 200);
    const passwordBody = await passwordResponse.json();
    assert.equal(passwordBody.mfaRequired, true);
    const pendingCookie = cookieFrom(passwordResponse);

    const pendingMe = await fetch(`${origin}/p/mfa-test-path/me`, {
      headers: { Cookie: pendingCookie, Accept: 'application/json' }, redirect: 'manual',
    });
    assert.equal(pendingMe.status, 401, 'password-only session must not enter the admin area');

    const challenge = await fetch(`${origin}/p/mfa-test-path/auth/google`, {
      headers: { Cookie: pendingCookie }, redirect: 'manual',
    });
    assert.equal(challenge.status, 302);
    assert.match(challenge.headers.get('location'), /^https:\/\/accounts\.google\.com\//);

    const callback = await fetch(
      `${origin}/p/mfa-test-path/auth/google/callback?state=fixed-state&code=test-code`,
      { headers: { Cookie: pendingCookie }, redirect: 'manual' }
    );
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/p/mfa-test-path/owl');
    const authenticatedCookie = cookieFrom(callback);

    const me = await fetch(`${origin}/p/mfa-test-path/me`, {
      headers: { Cookie: authenticatedCookie, Accept: 'application/json' },
    });
    const meText = await me.text();
    assert.equal(me.status, 200, meText);
    const meBody = JSON.parse(meText);
    assert.equal(meBody.admin.username, 'owner');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function cookieFrom(response) {
  const raw = response.headers.get('set-cookie');
  assert(raw, 'response should set a session cookie');
  return raw.split(';', 1)[0];
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
