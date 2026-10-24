const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');
const root = path.resolve(__dirname, '..');

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fountain-blank-start-'));
  const files = require('../release-manifest.json').files;
  for (const file of files) {
    const destination = path.join(directory, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, file), destination);
  }
  const child = spawn(process.execPath, ['server.js'], {
    cwd: directory,
    env: { PATH:process.env.PATH, SystemRoot:process.env.SystemRoot,
      TMP:process.env.TMP, TEMP:process.env.TEMP,
      HOST:'127.0.0.1', PORT:'0', NODE_ENV:'development',
      NODE_PATH:path.join(root, 'node_modules') },
    stdio:['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { errors += data; });
  try {
    let port;
    for (let i = 0; i < 200; i++) {
      const match = output.match(/listening on port (\d+)/);
      if (match) { port = Number(match[1]); break; }
      if (child.exitCode !== null) throw new Error(`Blank startup exited: ${errors}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(port, 'blank source release must start without a database or credentials');
    const base = `http://127.0.0.1:${port}`;
    for (const route of ['/install', '/health', '/css/app.css']) {
      assert.equal((await fetch(base + route)).status, 200, route);
    }
    for (const route of ['/.env', '/src/config.js', '/public/admin/index.html']) {
      assert.equal((await fetch(base + route)).status, 404, route);
    }
    const status = await (await fetch(base + '/install/status')).json();
    assert.equal(status.installed, false);
    assert.equal(status.configured, false);
    assert.equal(fs.existsSync(path.join(directory, '.env')), false);
    console.log('Blank release startup, installer and private-route checks passed');
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    // Only the newly created test-owned directory is removed.
    fs.rmSync(directory, {recursive: true, force: true});
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
