const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'commonjs' });
require('../client/node_modules/ts-node/register/transpile-only');

const {
  IMPORT_BATCH_BYTES,
  IMPORT_BATCH_SIZE,
} = require('../client/src/app/collection/import-config');

test('uses larger import document batches while keeping the payload byte cap conservative', () => {
  assert.equal(IMPORT_BATCH_SIZE, 1000);
  assert.equal(IMPORT_BATCH_BYTES, 5 * 1024 * 1024);
});

test('collection import uses the shared batch configuration', () => {
  const componentSource = fs.readFileSync(
    path.join(__dirname, '../client/src/app/collection/collection.component.ts'),
    'utf8'
  );

  assert.match(componentSource, /from '\.\/import-config'/);
  assert.doesNotMatch(componentSource, /const IMPORT_BATCH_SIZE =/);
  assert.doesNotMatch(componentSource, /const IMPORT_BATCH_BYTES =/);
});
