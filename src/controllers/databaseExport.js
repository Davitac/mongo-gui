const dataAccessAdapter = require('../db/dataAccessAdapter');
const Model = require('../models');
const exportUtils = require('./exportUtils');

const DEFAULT_BATCH_SIZE = 1000;
const MAX_BATCH_SIZE = 10000;
const STORE_METHOD = 0;
const ZIP64_VERSION = 45;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD_SIGNATURE = 0x06054b50;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function parsePayloadBody(body) {
  if (!body) return {};
  if (typeof body.payload === 'string') return JSON.parse(body.payload);
  return body;
}

function normalizePositiveInteger(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function normalizeDatabaseExportRequest(body) {
  const payload = parsePayloadBody(body);
  return {
    format: payload.format === 'csv' ? 'csv' : 'json',
    batchSize: normalizePositiveInteger(payload.batchSize, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE),
  };
}

function getDatabaseExportConcurrency(collectionCount) {
  if (collectionCount <= 0) return 0;
  if (collectionCount === 1) return 1;
  return Math.min(collectionCount, Math.max(2, Math.min(4, Math.ceil(Math.sqrt(collectionCount)))));
}

function updateCrc32(currentCrc, chunk) {
  let crc = currentCrc ^ -1;
  for (let index = 0; index < chunk.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ chunk[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), 'utf8');
}

function dateToDosParts(date) {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2)
    ) & 0xffff,
    date: (
      ((year - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate()
    ) & 0xffff,
  };
}

function writeUInt64LE(buffer, value, offset) {
  buffer.writeBigUInt64LE(BigInt(value), offset);
}

function createZip64Extra(values) {
  const payload = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => writeUInt64LE(payload, value, index * 8));

  const header = Buffer.alloc(4);
  header.writeUInt16LE(0x0001, 0);
  header.writeUInt16LE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function createLocalFileHeader(entry) {
  const extra = createZip64Extra([0n, 0n]);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(ZIP64_VERSION, 4);
  header.writeUInt16LE(DATA_DESCRIPTOR_FLAG, 6);
  header.writeUInt16LE(STORE_METHOD, 8);
  header.writeUInt16LE(entry.time, 10);
  header.writeUInt16LE(entry.date, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(UINT32_MAX, 18);
  header.writeUInt32LE(UINT32_MAX, 22);
  header.writeUInt16LE(entry.name.length, 26);
  header.writeUInt16LE(extra.length, 28);
  return Buffer.concat([header, entry.name, extra]);
}

function createDataDescriptor(entry) {
  const descriptor = Buffer.alloc(24);
  descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIGNATURE, 0);
  descriptor.writeUInt32LE(entry.crc32 >>> 0, 4);
  writeUInt64LE(descriptor, entry.size, 8);
  writeUInt64LE(descriptor, entry.size, 16);
  return descriptor;
}

function createCentralDirectoryHeader(entry) {
  const extra = createZip64Extra([entry.size, entry.size, entry.offset]);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
  header.writeUInt16LE(ZIP64_VERSION, 4);
  header.writeUInt16LE(ZIP64_VERSION, 6);
  header.writeUInt16LE(DATA_DESCRIPTOR_FLAG, 8);
  header.writeUInt16LE(STORE_METHOD, 10);
  header.writeUInt16LE(entry.time, 12);
  header.writeUInt16LE(entry.date, 14);
  header.writeUInt32LE(entry.crc32 >>> 0, 16);
  header.writeUInt32LE(UINT32_MAX, 20);
  header.writeUInt32LE(UINT32_MAX, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(extra.length, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(UINT32_MAX, 42);
  return Buffer.concat([header, entry.name, extra]);
}

function createZip64EndOfCentralDirectory(entryCount, centralDirectorySize, centralDirectoryOffset) {
  const record = Buffer.alloc(56);
  record.writeUInt32LE(ZIP64_EOCD_SIGNATURE, 0);
  writeUInt64LE(record, 44n, 4);
  record.writeUInt16LE(ZIP64_VERSION, 12);
  record.writeUInt16LE(ZIP64_VERSION, 14);
  record.writeUInt32LE(0, 16);
  record.writeUInt32LE(0, 20);
  writeUInt64LE(record, entryCount, 24);
  writeUInt64LE(record, entryCount, 32);
  writeUInt64LE(record, centralDirectorySize, 40);
  writeUInt64LE(record, centralDirectoryOffset, 48);
  return record;
}

function createZip64EndOfCentralDirectoryLocator(zip64EocdOffset) {
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(ZIP64_EOCD_LOCATOR_SIGNATURE, 0);
  locator.writeUInt32LE(0, 4);
  writeUInt64LE(locator, zip64EocdOffset, 8);
  locator.writeUInt32LE(1, 16);
  return locator;
}

function createEndOfCentralDirectory(entryCount, centralDirectorySize, centralDirectoryOffset) {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Math.min(Number(entryCount), UINT16_MAX), 8);
  eocd.writeUInt16LE(Math.min(Number(entryCount), UINT16_MAX), 10);
  eocd.writeUInt32LE(
    centralDirectorySize <= BigInt(UINT32_MAX) ? Number(centralDirectorySize) : UINT32_MAX,
    12
  );
  eocd.writeUInt32LE(
    centralDirectoryOffset <= BigInt(UINT32_MAX) ? Number(centralDirectoryOffset) : UINT32_MAX,
    16
  );
  eocd.writeUInt16LE(0, 20);
  return eocd;
}

class StreamingZipWriter {
  constructor(output, options = {}) {
    this.output = output;
    this.entries = [];
    this.offset = 0n;
    this.onProgress = options.onProgress || (() => {});
  }

  async write(chunk) {
    const buffer = toBuffer(chunk);
    await exportUtils.writeStreamChunk(this.output, buffer);
    this.offset += BigInt(buffer.length);
  }

  async writeEntry(fileName, writer) {
    const now = dateToDosParts(new Date());
    const entry = {
      fileName,
      name: Buffer.from(fileName, 'utf8'),
      offset: this.offset,
      time: now.time,
      date: now.date,
      crc32: 0,
      size: 0n,
    };

    await this.write(createLocalFileHeader(entry));

    const write = async (chunk) => {
      const buffer = toBuffer(chunk);
      entry.crc32 = updateCrc32(entry.crc32, buffer);
      entry.size += BigInt(buffer.length);
      await this.write(buffer);
    };

    await writer(write);
    await this.write(createDataDescriptor(entry));
    this.entries.push(entry);
    this.onProgress({
      entryIndex: this.entries.length - 1,
      entriesWritten: this.entries.length,
      fileName,
      bytesWritten: this.offset,
    });
  }

  async finish() {
    const centralDirectoryOffset = this.offset;
    for (const entry of this.entries) {
      await this.write(createCentralDirectoryHeader(entry));
    }
    const centralDirectorySize = this.offset - centralDirectoryOffset;
    const zip64EocdOffset = this.offset;
    const entryCount = BigInt(this.entries.length);

    await this.write(createZip64EndOfCentralDirectory(
      entryCount,
      centralDirectorySize,
      centralDirectoryOffset
    ));
    await this.write(createZip64EndOfCentralDirectoryLocator(zip64EocdOffset));
    await this.write(createEndOfCentralDirectory(
      entryCount,
      centralDirectorySize,
      centralDirectoryOffset
    ));
  }
}

async function streamZipEntries(entries, output, options = {}) {
  const zip = new StreamingZipWriter(output, options);
  for (const entry of entries) {
    await zip.writeEntry(entry.fileName, entry.write);
  }
  await zip.finish();
  await exportUtils.endWritable(output);
}

class AsyncChunkQueue {
  constructor(maxBufferedChunks = 32) {
    this.maxBufferedChunks = maxBufferedChunks;
    this.items = [];
    this.readers = [];
    this.writers = [];
    this.closed = false;
    this.error = null;
  }

  async push(chunk) {
    while (!this.closed && !this.error && this.items.length >= this.maxBufferedChunks) {
      await new Promise((resolve, reject) => {
        this.writers.push({ resolve, reject });
      });
    }
    if (this.error) throw this.error;
    if (this.closed) return;

    if (this.readers.length) {
      const reader = this.readers.shift();
      reader.resolve({ value: chunk, done: false });
      return;
    }
    this.items.push(chunk);
  }

  shift() {
    if (this.items.length) {
      const value = this.items.shift();
      this.wakeWriter();
      return Promise.resolve({ value, done: false });
    }
    if (this.error) return Promise.reject(this.error);
    if (this.closed) return Promise.resolve({ done: true });
    return new Promise((resolve, reject) => {
      this.readers.push({ resolve, reject });
    });
  }

  wakeWriter() {
    const writer = this.writers.shift();
    if (writer) writer.resolve();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    while (this.readers.length) this.readers.shift().resolve({ done: true });
    while (this.writers.length) this.writers.shift().resolve();
  }

  fail(err) {
    if (this.closed) return;
    this.error = err;
    this.closed = true;
    while (this.readers.length) this.readers.shift().reject(err);
    while (this.writers.length) this.writers.shift().reject(err);
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = await this.shift();
      if (next.done) return;
      yield next.value;
    }
  }
}

function indentLines(text, spaces) {
  const indent = ' '.repeat(spaces);
  return text.split('\n').map(line => indent + line).join('\n');
}

async function produceJsonCollection(cursor, queue) {
  let first = true;
  await queue.push('[');
  for await (const document of cursor) {
    await queue.push(first ? '\n' : ',\n');
    await queue.push(indentLines(exportUtils.stringifyDocumentAsClassicJson(document), 2));
    first = false;
  }
  await queue.push(first ? ']' : '\n]');
}

async function produceCsvCollection(cursor, queue) {
  let fields = [];
  let wroteHeader = false;

  for await (const document of cursor) {
    if (!wroteHeader) {
      fields = Object.keys(document);
      await queue.push(fields.map(exportUtils.csvEscapeValue).join(','));
      await queue.push('\n');
      wroteHeader = true;
    }
    await queue.push(fields.map(field => exportUtils.csvEscapeValue(document[field])).join(','));
    await queue.push('\n');
  }
}

function createCollectionProducer(dbName, collection, request) {
  let cursor;
  let started = false;
  let task = Promise.resolve();
  const queue = new AsyncChunkQueue();

  async function closeCursor() {
    if (cursor && cursor.close) {
      try {
        await cursor.close();
      } catch (err) {}
    }
  }

  return {
    fileName: collection.fileName,
    start() {
      if (started) return task;
      started = true;
      task = (async () => {
        try {
          const model = new Model(dbName, collection.name);
          cursor = model.find({}, { batchSize: request.batchSize });
          if (request.format === 'csv') {
            await produceCsvCollection(cursor, queue);
          } else {
            await produceJsonCollection(cursor, queue);
          }
          queue.close();
        } catch (err) {
          queue.fail(err);
        } finally {
          await closeCursor();
        }
      })();
      return task;
    },
    chunks: queue,
    async close() {
      queue.close();
      await closeCursor();
    },
  };
}

function buildCollectionExportPlan(collections, format) {
  const usedNames = new Set();
  const extension = format === 'csv' ? 'csv' : 'json';
  return collections.map((collection) => {
    const baseName = exportUtils.safeFilename(collection.name);
    let fileName = `${baseName}.${extension}`;
    let suffix = 2;
    while (usedNames.has(fileName)) {
      fileName = `${baseName}-${suffix}.${extension}`;
      suffix += 1;
    }
    usedNames.add(fileName);
    return {
      name: collection.name,
      fileName,
    };
  });
}

async function listDatabaseCollections(dbName) {
  const db = dataAccessAdapter.ConnectToDb(dbName);
  const collections = await db.listCollections().toArray();
  return collections
    .filter(collection => !collection.name.startsWith('system.'))
    .sort((first, second) => first.name.localeCompare(second.name));
}

function setDatabaseExportHeaders(res, dbName) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${exportUtils.safeFilename(dbName)}.zip"`
  );
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

async function exportDatabase(req, res, next) {
  const dbName = req.params.dbName;
  let closeAllProducers = () => {};

  try {
    const request = normalizeDatabaseExportRequest(req.body);
    const collectionNames = await listDatabaseCollections(dbName);
    const collectionPlan = buildCollectionExportPlan(collectionNames, request.format);
    const concurrency = getDatabaseExportConcurrency(collectionPlan.length);
    const producers = collectionPlan.map(collection => createCollectionProducer(dbName, collection, request));
    let nextProducerToStart = 0;

    function startProducersThrough(index) {
      while (nextProducerToStart <= index && nextProducerToStart < producers.length) {
        producers[nextProducerToStart].start();
        nextProducerToStart += 1;
      }
    }

    closeAllProducers = function closeProducers() {
      producers.forEach(producer => producer.close());
    };

    const manifest = {
      database: dbName,
      format: request.format,
      batchSize: request.batchSize,
      concurrency,
      generatedAt: new Date().toISOString(),
      collections: collectionPlan,
    };

    const entries = [
      {
        fileName: 'collections.json',
        async write(write) {
          await write(JSON.stringify(manifest, null, 2));
          await write('\n');
        },
      },
      ...producers.map((producer, index) => ({
        fileName: producer.fileName,
        async write(write) {
          startProducersThrough(index + concurrency - 1);
          producer.start();
          for await (const chunk of producer.chunks) {
            await write(chunk);
          }
        },
      })),
    ];

    res.on('close', () => {
      if (!res.writableEnded && !res.writableFinished) closeAllProducers();
    });

    setDatabaseExportHeaders(res, dbName);
    startProducersThrough(concurrency - 1);
    await streamZipEntries(entries, res);
  } catch (err) {
    closeAllProducers();
    if (!res.headersSent) {
      return res.status(400).send(err.toString());
    }
    console.log(err);
    if (!res.destroyed) res.destroy(err);
  }
}

module.exports = {
  exportDatabase,
  getDatabaseExportConcurrency,
  normalizeDatabaseExportRequest,
  streamZipEntries,
};
