const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { createAdminCrmRouter } = require('../src/routes/adminCrm');

async function run() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { admin: { id: 'admin-1', role: 'admin' } };
    next();
  });
  app.use(createAdminCrmRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/crm/integrations/test`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Save the integration before testing/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'crm-integrations.html'), 'utf8');
  assert.match(html, /\.actions \[hidden\] \{ display: none !important; \}/);
  assert.match(html, /if \(!id\) throw new Error\('Save the integration before testing the connection\.'\)/);
  assert.match(html, /crm\.example\.invalid/);
  console.log('Admin CRM tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
