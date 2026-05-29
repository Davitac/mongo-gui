const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

const {
  normalizeDatabaseExportRequest,
  streamZipEntries,
} = require('../src/controllers/databaseExport');

class BufferSink extends Writable {
  constructor() {
    super();
    this.chunks = [];
  }

  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  buffer() {
    return Buffer.concat(this.chunks);
  }
}

function readUInt32LE(buffer, offset) {
  return buffer.readUInt32LE(buffer.indexOf(Buffer.from(offset, 'binary')));
}

test('normalizes database export requests for streamed JSON and CSV zip downloads', () => {
  assert.deepEqual(normalizeDatabaseExportRequest({ format: 'csv', batchSize: 500 }), {
    format: 'csv',
    batchSize: 500,
  });
  assert.deepEqual(normalizeDatabaseExportRequest({ payload: JSON.stringify({ format: 'json', batchSize: 50 }) }), {
    format: 'json',
    batchSize: 50,
  });
  assert.equal(normalizeDatabaseExportRequest({ format: 'xml' }).format, 'json');
  assert.equal(normalizeDatabaseExportRequest({ batchSize: 999999 }).batchSize, 10000);
});

test('streams zip entries progressively with data descriptors instead of prebuilt file sizes', async () => {
  const sink = new BufferSink();
  const progress = [];

  await streamZipEntries([
    {
      fileName: 'collections.json',
      async write(write) {
        await write('{"collections":[{"name":"orders"}]}');
      },
    },
    {
      fileName: 'orders.json',
      async write(write) {
        await write('[\n');
        await write('  {"_id":1}\n');
        await write(']');
      },
    },
  ], sink, {
    onProgress(update) {
      progress.push(update);
    },
  });

  const zip = sink.buffer();
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt16LE(6), 0x0008);
  assert.ok(zip.includes(Buffer.from('collections.json')));
  assert.ok(zip.includes(Buffer.from('orders.json')));
  assert.ok(zip.includes(Buffer.from('{"_id":1}')));
  assert.ok(zip.includes(Buffer.from('PK\u0007\b', 'binary')));
  assert.ok(zip.includes(Buffer.from('PK\u0001\u0002', 'binary')));
  assert.ok(zip.includes(Buffer.from('PK\u0005\u0006', 'binary')));
  assert.equal(readUInt32LE(zip, 'PK\u0005\u0006'), 0x06054b50);
  assert.equal(progress.at(-1).entryIndex, 1);
  assert.equal(progress.at(-1).entriesWritten, 2);
});
