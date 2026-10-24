const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'sql', 'schema.sql'), 'utf8');
const charter = fs.readFileSync(
  path.join(root, 'content', 'docs', 'preservation-sync-phase-0.md'),
  'utf8'
);
const inventory = fs.readFileSync(
  path.join(root, 'content', 'docs', 'preservation-data-inventory.md'),
  'utf8'
);
const docsRoute = fs.readFileSync(path.join(root, 'src', 'routes', 'docs.js'), 'utf8');

const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+`?([a-z0-9_]+)`?\s*\(/gi)]
  .map((match) => match[1]);

assert(tables.length > 0, 'Expected schema tables to be discoverable');
const missingTables = tables.filter((table) => !inventory.includes(`\`${table}\``));
assert.deepStrictEqual(
  missingTables,
  [],
  `Every application table must be classified in the preservation inventory: ${missingTables.join(', ')}`
);

[
  'Portable preservation export',
  'Application configuration backup',
  'Disaster-recovery backup',
  'off-instance',
  'RPO',
  'RTO',
  'one-way',
  'legal',
  'restore',
  'installation-defined',
].forEach((requiredText) => {
  assert(
    charter.toLowerCase().includes(requiredText.toLowerCase()),
    `Phase 0 charter must cover ${requiredText}`
  );
});

[
  'preservation-sync-phase-0',
  'preservation-data-inventory',
].forEach((slug) => {
  assert(docsRoute.includes(`'${slug}'`), `Documentation navigation must include ${slug}`);
});

console.log(`Phase 0 preservation policy validated across ${tables.length} schema tables.`);
