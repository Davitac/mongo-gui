const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'commonjs' });
require('../client/node_modules/ts-node/register/transpile-only');

const { AppComponent } = require('../client/src/app/app.component');
const appComponentTemplatePath = path.join(__dirname, '../client/src/app/app.component.html');

function createNamedBlob(name, content, type = 'application/json') {
  const file = new Blob([content], { type });
  file.name = name;
  return file;
}

function createResolvedObservable(value) {
  return {
    toPromise: () => Promise.resolve(value),
  };
}

test('bulk import creates empty collections from empty JSON array files', async () => {
  const calls = [];
  const messages = [];
  const api = {
    createCollection: (body) => {
      calls.push(['createCollection', body]);
      return createResolvedObservable({ message: 'success' });
    },
    createDocuments: (database, collection, documents) => {
      calls.push(['createDocuments', database, collection, documents]);
      return createResolvedObservable({ ok: 1 });
    },
  };
  const component = new AppComponent(api, {}, {
    success: (message) => messages.push(message),
  });

  component.bulkImportTarget = { database: 'shop' };
  component.bulkImportPlan = [
    {
      collectionName: 'customerSearchBackup',
      file: createNamedBlob('customerSearchBackup.json', '[]'),
      format: 'json',
    },
    {
      collectionName: 'emptyOrders',
      file: createNamedBlob('emptyOrders.json', '[]'),
      format: 'json',
    },
  ];
  component.getDatabases = () => {};
  component.showCollections = () => {};

  await component.importDatabaseCollections();

  assert.deepEqual(calls, [
    ['createCollection', { database: 'shop', collection: 'customerSearchBackup' }],
    ['createCollection', { database: 'shop', collection: 'emptyOrders' }],
  ]);
  assert.equal(component.bulkImportError, '');
  assert.equal(component.bulkImportImportedCollections, 2);
  assert.equal(component.bulkImportImportedRecords, 0);
  assert.deepEqual(messages, ['Imported 2 collections and 0 records.']);
});

test('database import and export actions use the intended directional icons', () => {
  const template = fs.readFileSync(appComponentTemplatePath, 'utf8');

  assert.match(
    template,
    /nzType="upload"[^>]*nzTooltipTitle="Export database"/
  );
  assert.match(
    template,
    /nzType="download"[^>]*nzTooltipTitle="Import collections"/
  );
});
