const { test } = require('node:test');
const assert = require('node:assert/strict');
const Papa = require('../client/node_modules/papaparse');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'commonjs' });
require('../client/node_modules/ts-node/register/transpile-only');

const {
  calculateImportProgressPercent,
  convertCsvRowToRecord,
  createImportAttributes,
  formatFileReadError,
  getCollectionNameFromImportFile,
  getCsvParseError,
  getCsvHeaderFieldsFromText,
  getCsvPreviewError,
  getCsvPreviewFields,
  getImportFileFormat,
  readBlobTextChunks,
  readJsonArrayRecords,
  validateBulkImportFiles,
} = require('../client/src/app/collection/import-file-utils');

test('detects downloaded JSON and CSV files even when the browser exposes a generic MIME type', () => {
  assert.equal(getImportFileFormat({ name: 'orders.json', type: '' }), 'json');
  assert.equal(getImportFileFormat({ name: 'orders.csv', type: 'application/octet-stream' }), 'csv');
  assert.equal(getImportFileFormat({ name: 'orders.csv', type: 'application/vnd.ms-excel' }), 'csv');
});

test('detects database export ZIPs so the import UI can reject them with a clear message', () => {
  assert.equal(getImportFileFormat({ name: 'database.zip', type: 'application/zip' }), 'zip');
});

test('derives new collection names from JSON and CSV filenames', () => {
  assert.equal(getCollectionNameFromImportFile('orders.json'), 'orders');
  assert.equal(getCollectionNameFromImportFile('customer.accounts.csv'), 'customer.accounts');
  assert.equal(getCollectionNameFromImportFile('  inventory snapshot.JSON  '), 'inventory snapshot');
});

test('validates bulk import file lists before creating collections', () => {
  const files = [
    { name: 'orders.json', type: 'application/json' },
    { name: 'customers.csv', type: 'text/csv' },
  ];

  assert.deepEqual(
    validateBulkImportFiles(files, ['products']).map(file => ({
      collectionName: file.collectionName,
      format: file.format,
    })),
    [
      { collectionName: 'orders', format: 'json' },
      { collectionName: 'customers', format: 'csv' },
    ]
  );

  assert.throws(
    () => validateBulkImportFiles([{ name: 'orders.json' }, { name: 'orders.csv' }], []),
    /Duplicate target collection/
  );
  assert.throws(
    () => validateBulkImportFiles([{ name: 'products.csv' }], ['products']),
    /already exists/
  );
});

test('converts CSV rows through reusable import attributes', () => {
  const attributes = createImportAttributes(['name', 'active', 'stock']);
  attributes.find(attribute => attribute.label === 'active').type = 'Boolean';
  attributes.find(attribute => attribute.label === 'stock').type = 'Number';

  assert.deepEqual(
    convertCsvRowToRecord({ name: 'Boots', active: 'true', stock: '12' }, attributes),
    { name: 'Boots', active: true, stock: { $numberInt: '12' } }
  );
});

test('normalizes browser file read failures into an actionable message', () => {
  assert.match(
    formatFileReadError({ name: 'NotReadableError' }),
    /download is complete/
  );
});

test('calculates import progress from processed file bytes without reaching 100 before completion', () => {
  assert.equal(calculateImportProgressPercent(1000, 0, false), 0);
  assert.equal(calculateImportProgressPercent(1000, 250, false), 25);
  assert.equal(calculateImportProgressPercent(1000, 1000, false), 99);
  assert.equal(calculateImportProgressPercent(1000, 1000, true), 100);
  assert.equal(calculateImportProgressPercent(0, 500, false), 99);
});

test('reports blob read progress while streaming import chunks', async () => {
  const progress = [];
  const chunks = [];

  for await (const chunk of readBlobTextChunks(new Blob(['abcdef']), 2, (bytesRead, totalBytes) => {
    progress.push([bytesRead, totalBytes]);
  })) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, ['ab', 'cd', 'ef']);
  assert.deepEqual(progress, [[2, 6], [4, 6], [6, 6]]);
});

test('accepts single-column CSV previews exported by mongo-gui despite delimiter warnings', () => {
  const result = Papa.parse('_id\n693cadaca3af-1779874868249\n', {
    header: true,
    preview: 1,
    skipEmptyLines: true,
  });

  assert.deepEqual(getCsvPreviewFields(result), ['_id']);
  assert.equal(getCsvPreviewError(result), '');
});

test('does not surface PapaParse delimiter warnings during single-column CSV import chunks', () => {
  const result = Papa.parse('_id\n693cadaca3af-1779874868249\n', {
    header: true,
    skipEmptyLines: true,
  });

  assert.equal(
    result.errors[0].message,
    "Unable to auto-detect delimiting character; defaulted to ','"
  );
  assert.equal(getCsvParseError(result), '');
});

test('does not fail streaming CSV import when delimiter warning arrives before headers', () => {
  let firstChunk;
  Papa.parse('_id\n693cadaca3af-1779874868249\n', {
    header: true,
    skipEmptyLines: true,
    chunkSize: 1,
    chunk: (result, parser) => {
      if (!firstChunk) {
        firstChunk = result;
        parser.abort();
      }
    },
  });

  assert.equal(
    firstChunk.errors[0].message,
    "Unable to auto-detect delimiting character; defaulted to ','"
  );
  assert.equal(getCsvParseError(firstChunk, { requireFields: false }), '');
});

test('extracts CSV headers from the first text chunk without requiring parser metadata fields', () => {
  assert.deepEqual(
    getCsvHeaderFieldsFromText('_id\n693cadaca3af-1779874868249\n'),
    ['_id']
  );
  assert.deepEqual(
    getCsvHeaderFieldsFromText('\n\n"_id","name, full"\n1,"one"\n'),
    ['_id', 'name, full']
  );
});

test('reads JSON array records from text chunks without requiring the full file in memory', async () => {
  async function* chunks() {
    yield '[\n  {"_id":1,"name":"o';
    yield 'ne","nested":{"enabled":true}},\n';
    yield '  {"_id":2,"name":"two"}\n]';
  }

  const records = [];
  for await (const record of readJsonArrayRecords(chunks())) {
    records.push(record);
  }

  assert.deepEqual(records, [
    { _id: 1, name: 'one', nested: { enabled: true } },
    { _id: 2, name: 'two' },
  ]);
});

test('reports truncated JSON array imports as unexpected end of input', async () => {
  async function* chunks() {
    yield '[{"_id":1}';
  }

  await assert.rejects(
    async () => {
      for await (const _record of readJsonArrayRecords(chunks())) {}
    },
    /Unexpected end of JSON input/
  );
});
