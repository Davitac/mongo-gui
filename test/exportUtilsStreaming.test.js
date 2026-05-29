const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

const {
  streamCursorAsCsv,
  streamCursorAsJson,
  streamCursorAsNdjson,
} = require('../src/controllers/exportUtils');

class SlowSink extends Writable {
  constructor(delayMs = 10) {
    super();
    this.delayMs = delayMs;
    this.chunks = [];
  }

  _write(chunk, encoding, callback) {
    setTimeout(() => {
      this.chunks.push(Buffer.from(chunk));
      callback();
    }, this.delayMs);
  }

  text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

async function* documents() {
  yield { _id: 1, name: 'one' };
  yield { _id: 2, name: 'two' };
}

test('JSON cursor export resolves only after the streamed file is fully readable', async () => {
  const sink = new SlowSink();

  await streamCursorAsJson(documents(), sink);

  assert.equal(sink.writableFinished, true);
  assert.deepEqual(JSON.parse(sink.text()), [
    { _id: 1, name: 'one' },
    { _id: 2, name: 'two' },
  ]);
});

test('CSV cursor export resolves only after the streamed file is fully readable', async () => {
  const sink = new SlowSink();

  await streamCursorAsCsv(documents(), sink, []);

  assert.equal(sink.writableFinished, true);
  assert.equal(sink.text(), '_id,name\n1,one\n2,two\n');
});

test('NDJSON cursor export resolves only after the streamed file is fully readable', async () => {
  const sink = new SlowSink();

  await streamCursorAsNdjson(documents(), sink);

  assert.equal(sink.writableFinished, true);
  assert.equal(sink.text().split('\n').filter(Boolean).length, 2);
});
