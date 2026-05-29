const EJSON = require('bson').EJSON;

const DEFAULT_BATCH_SIZE = 1000;
const MAX_BATCH_SIZE = 10000;
const DEFAULT_PREVIEW_LIMIT = 100;
const MAX_PREVIEW_LIMIT = 1000;
const READ_ONLY_BLOCKED_STAGES = new Set(['$out', '$merge']);

function parsePayloadBody(body) {
  if (!body) return {};
  if (typeof body.payload === 'string') return JSON.parse(body.payload);
  return body;
}

function deserializeEjson(value, fallback) {
  if (typeof value === 'undefined' || value === null) return fallback;
  return EJSON.deserialize(value);
}

function normalizePositiveInteger(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function normalizeFormat(value) {
  if (value === 'csv' || value === 'ndjson') return value;
  return 'json';
}

function normalizeFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields
    .filter(field => typeof field === 'string')
    .map(field => field.trim())
    .filter(Boolean);
}

function normalizeExportRequest(body) {
  const payload = parsePayloadBody(body);
  const mode = payload.mode === 'aggregate' ? 'aggregate' : 'find';
  return {
    mode,
    format: normalizeFormat(payload.format),
    filter: deserializeEjson(payload.filter, {}),
    pipeline: deserializeEjson(payload.pipeline, []),
    fields: normalizeFields(payload.fields),
    batchSize: normalizePositiveInteger(payload.batchSize, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE),
  };
}

function normalizeAggregationPreviewRequest(body, query) {
  const payload = parsePayloadBody(body);
  const pipeline = Array.isArray(payload) ? payload : payload.pipeline;
  return {
    pipeline: deserializeEjson(pipeline, []),
    limit: normalizePositiveInteger(
      payload.limit || (query && query.limit),
      DEFAULT_PREVIEW_LIMIT,
      MAX_PREVIEW_LIMIT
    ),
    batchSize: normalizePositiveInteger(
      payload.batchSize || (query && query.batchSize),
      DEFAULT_BATCH_SIZE,
      MAX_BATCH_SIZE
    ),
    allowDiskUse: payload.allowDiskUse === true || payload.allowDiskUse === 'true',
  };
}

function validateReadOnlyPipeline(pipeline) {
  if (!Array.isArray(pipeline)) {
    throw new Error('Aggregation pipeline must be an array');
  }
  pipeline.forEach(stage => {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
      throw new Error('Aggregation pipeline stages must be objects');
    }
    Object.keys(stage).forEach(operator => {
      if (READ_ONLY_BLOCKED_STAGES.has(operator)) {
        throw new Error(`Aggregation stage ${operator} is not allowed in this GUI`);
      }
    });
  });
}

function csvEscapeValue(value) {
  if (value === null || typeof value === 'undefined') return '';
  let normalized = value;
  if (typeof normalized === 'object') {
    normalized = JSON.stringify(EJSON.serialize(normalized));
  }
  const text = String(normalized);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function readField(document, field) {
  if (!field) return undefined;
  return field.split('.').reduce((value, key) => {
    if (value === null || typeof value === 'undefined') return undefined;
    return value[key];
  }, document);
}

function stringifyDocumentAsClassicJson(document) {
  const canonical = EJSON.stringify(document, { relaxed: false });
  return JSON.stringify(EJSON.parse(canonical), null, 2);
}

function indentLines(text, spaces) {
  const indent = ' '.repeat(spaces);
  return text.split('\n').map(line => indent + line).join('\n');
}

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), 'utf8');
}

function writeStreamChunk(output, chunk) {
  const buffer = toBuffer(chunk);
  if (!buffer.length) return Promise.resolve();
  if (output.destroyed || output.writableEnded) {
    return Promise.reject(new Error('Output stream is closed'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    function cleanup() {
      output.removeListener('error', onError);
      output.removeListener('close', onClose);
    }

    function done(err) {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    }

    function onError(err) {
      done(err);
    }

    function onClose() {
      if (output.writableEnded || output.writableFinished) done();
      else done(new Error('Output stream is closed'));
    }

    output.once('error', onError);
    output.once('close', onClose);

    try {
      output.write(buffer, done);
    } catch (err) {
      done(err);
    }
  });
}

function endWritable(output, chunk) {
  if (output.destroyed || output.writableEnded) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;

    function cleanup() {
      output.removeListener('error', onError);
      output.removeListener('close', onClose);
    }

    function done(err) {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    }

    function onError(err) {
      done(err);
    }

    function onClose() {
      if (output.writableEnded || output.writableFinished) done();
      else done(new Error('Output stream is closed'));
    }

    output.once('error', onError);
    output.once('close', onClose);

    try {
      if (typeof chunk === 'undefined') output.end(done);
      else output.end(toBuffer(chunk), done);
    } catch (err) {
      done(err);
    }
  });
}

async function streamCursorAsJson(cursor, res) {
  let first = true;
  await writeStreamChunk(res, '[');
  for await (const document of cursor) {
    await writeStreamChunk(res, first ? '\n' : ',\n');
    await writeStreamChunk(res, indentLines(stringifyDocumentAsClassicJson(document), 2));
    first = false;
  }
  await endWritable(res, first ? ']' : '\n]');
}

async function streamCursorAsNdjson(cursor, res) {
  for await (const document of cursor) {
    await writeStreamChunk(res, EJSON.stringify(document, { relaxed: false }));
    await writeStreamChunk(res, '\n');
  }
  await endWritable(res);
}

async function streamCursorAsCsv(cursor, res, fields) {
  let resolvedFields = normalizeFields(fields);
  let wroteHeader = false;

  if (resolvedFields.length) {
    await writeStreamChunk(res, resolvedFields.map(csvEscapeValue).join(','));
    await writeStreamChunk(res, '\n');
    wroteHeader = true;
  }

  for await (const document of cursor) {
    if (!wroteHeader) {
      resolvedFields = Object.keys(document);
      await writeStreamChunk(res, resolvedFields.map(csvEscapeValue).join(','));
      await writeStreamChunk(res, '\n');
      wroteHeader = true;
    }
    await writeStreamChunk(res, resolvedFields.map(field => csvEscapeValue(readField(document, field))).join(','));
    await writeStreamChunk(res, '\n');
  }

  await endWritable(res);
}

function safeFilename(value) {
  return String(value || 'collection')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'collection';
}

function setExportHeaders(res, collectionName, format) {
  const extension = format === 'csv' ? 'csv' : (format === 'ndjson' ? 'ndjson' : 'json');
  const contentType = format === 'csv' ?
    'text/csv; charset=utf-8' :
    (format === 'ndjson' ? 'application/x-ndjson; charset=utf-8' : 'application/json; charset=utf-8');
  res.setHeader('Content-Type', contentType);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${safeFilename(collectionName)}.${extension}"`
  );
  res.setHeader('Cache-Control', 'no-store');
}

module.exports = {
  csvEscapeValue,
  endWritable,
  normalizeAggregationPreviewRequest,
  normalizeExportRequest,
  safeFilename,
  setExportHeaders,
  stringifyDocumentAsClassicJson,
  streamCursorAsCsv,
  streamCursorAsJson,
  streamCursorAsNdjson,
  validateReadOnlyPipeline,
  writeStreamChunk,
};
