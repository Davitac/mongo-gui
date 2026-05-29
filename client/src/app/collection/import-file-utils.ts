export type ImportFileFormat = 'json' | 'csv' | 'zip';
export const DEFAULT_IMPORT_READ_CHUNK_SIZE = 1024 * 1024;
export type ImportReadProgressCallback = (bytesRead: number, totalBytes: number) => void;
const Papa = require('papaparse');

export function getImportFileFormat(file: { name?: string; type?: string }): ImportFileFormat | null {
  const name = String(file && file.name || '').toLowerCase();
  const type = String(file && file.type || '').toLowerCase();

  if (type.indexOf('json') > -1 || name.endsWith('.json')) return 'json';
  if (
    type.indexOf('csv') > -1 ||
    type === 'application/vnd.ms-excel' ||
    name.endsWith('.csv')
  ) return 'csv';
  if (type.indexOf('zip') > -1 || name.endsWith('.zip')) return 'zip';

  return null;
}

export function formatFileReadError(error: any): string {
  if (error && error.name === 'NotReadableError') {
    return 'The selected file could not be read. Wait until the download is complete, then select it again. For large files, keep the file in a local folder and retry.';
  }
  return error && (error.message || error.name) || 'The selected file could not be read.';
}

export function getCsvPreviewFields(result: any): string[] {
  const fields = result && result.meta && result.meta.fields ?
    result.meta.fields :
    Object.keys(result && result.data && result.data[0] || {});

  if (!Array.isArray(fields)) return [];
  return fields
    .map(field => String(field || '').replace(/^\ufeff/, '').trim())
    .filter(Boolean);
}

function stripCsvPreviewPrefix(text: string): string {
  let normalized = String(text || '').replace(/^\ufeff/, '');
  normalized = normalized.replace(/^(?:[ \t]*(?:\r\n|\n|\r))+/, '');

  if (/^sep=./i.test(normalized)) {
    normalized = normalized.replace(/^[^\r\n]*(?:\r\n|\n|\r)?/, '');
    normalized = normalized.replace(/^(?:[ \t]*(?:\r\n|\n|\r))+/, '');
  }

  return normalized;
}

export function getCsvHeaderFieldsFromText(text: string): string[] {
  const normalized = stripCsvPreviewPrefix(text);
  const result = Papa.parse(normalized, {
    preview: 1,
    skipEmptyLines: true,
  });
  const firstRow = result && result.data && Array.isArray(result.data[0]) ? result.data[0] : [];

  return firstRow
    .map(field => String(field || '').replace(/^\ufeff/, '').trim())
    .filter(Boolean);
}

export function getCsvParseError(result: any, options: { requireFields?: boolean } = {}): string {
  const requireFields = options.requireFields !== false;
  const fields = getCsvPreviewFields(result);
  const errors = result && result.errors instanceof Array ? result.errors : [];
  const fatalError = errors.find(error => {
    return !(error.type === 'Delimiter' && error.code === 'UndetectableDelimiter');
  });

  if (fatalError) return fatalError.message || fatalError.code || 'Invalid CSV file.';
  if (requireFields && !fields.length) return 'The CSV file does not contain a header row.';
  return '';
}

export function getCsvPreviewError(result: any): string {
  return getCsvParseError(result);
}

export function readBlobAsText(blob: Blob): Promise<string> {
  if (blob && typeof (blob as any).text === 'function') {
    return (blob as any).text();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

export function calculateImportProgressPercent(
  totalBytes: number,
  processedBytes: number,
  complete = false
): number {
  if (complete) return 100;
  if (processedBytes <= 0) return 0;
  if (totalBytes <= 0) return 99;
  return Math.min(99, Math.max(0, Math.floor((processedBytes / totalBytes) * 100)));
}

export async function* readBlobTextChunks(
  blob: Blob,
  chunkSize = DEFAULT_IMPORT_READ_CHUNK_SIZE,
  onProgress?: ImportReadProgressCallback
): AsyncIterable<string> {
  let offset = 0;
  while (offset < blob.size) {
    const nextOffset = Math.min(offset + chunkSize, blob.size);
    const text = await readBlobAsText(blob.slice(offset, nextOffset));
    offset = nextOffset;
    if (onProgress) onProgress(offset, blob.size);
    yield text;
  }
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\ufeff';
}

export async function* readJsonArrayRecords(chunks: AsyncIterable<string>): AsyncIterable<any> {
  let buffer = '';
  let started = false;
  let finished = false;
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaping = false;
  let scanIndex = 0;

  for await (const chunk of chunks) {
    buffer += chunk;

    for (let index = scanIndex; index < buffer.length; index += 1) {
      const char = buffer[index];

      if (finished) {
        if (!isWhitespace(char)) throw new Error('Unexpected content after JSON array');
        continue;
      }

      if (!started) {
        if (isWhitespace(char)) continue;
        if (char !== '[') throw new Error('The JSON import file must contain an array of documents.');
        started = true;
        buffer = buffer.slice(index + 1);
        scanIndex = 0;
        index = -1;
        continue;
      }

      if (depth === 0) {
        if (isWhitespace(char) || char === ',') continue;
        if (char === ']') {
          finished = true;
          continue;
        }
        if (char !== '{') throw new Error('The JSON import file must contain document objects.');
        objectStart = index;
        depth = 1;
        continue;
      }

      if (inString) {
        if (escaping) {
          escaping = false;
        } else if (char === '\\') {
          escaping = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const recordText = buffer.slice(objectStart, index + 1);
          yield JSON.parse(recordText);
          buffer = buffer.slice(index + 1);
          objectStart = -1;
          scanIndex = 0;
          index = -1;
        }
      }
    }

    if (depth === 0 && !finished) {
      buffer = buffer.replace(/^[\s,\ufeff]+/, '');
    }
    scanIndex = buffer.length;
  }

  if (!started && !buffer.trim()) throw new Error('The JSON file is empty.');
  if (!finished) throw new Error('Unexpected end of JSON input');
}

export function readJsonFileRecords(
  file: Blob,
  chunkSize = DEFAULT_IMPORT_READ_CHUNK_SIZE,
  onProgress?: ImportReadProgressCallback
): AsyncIterable<any> {
  return readJsonArrayRecords(readBlobTextChunks(file, chunkSize, onProgress));
}

export async function readFirstTextChunk(
  file: Blob,
  chunkSize = DEFAULT_IMPORT_READ_CHUNK_SIZE
): Promise<string> {
  if (!file || !file.size) return '';
  const firstSlice = file.slice(0, Math.min(chunkSize, file.size));
  return readBlobAsText(firstSlice);
}
