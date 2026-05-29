import { Component, OnInit, Input } from '@angular/core';
import { ApiService } from '../api.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { EJSON, ObjectId } from 'bson';
import {
  NzNotificationService,
  NzTreeHigherOrderServiceToken,
} from 'ng-zorro-antd';
import * as _ from 'lodash';
import {
  calculateImportProgressPercent,
  formatFileReadError,
  getCsvHeaderFieldsFromText,
  getCsvParseError,
  getImportFileFormat,
  ImportFileFormat,
  readBlobAsText,
  readFirstTextChunk,
  readJsonFileRecords,
} from './import-file-utils';
import { IMPORT_BATCH_BYTES, IMPORT_BATCH_SIZE } from './import-config';

const Papa = require('papaparse');

interface ImportState {
  batch: any[];
  bytes: number;
  importedRecords: number;
  confirmedRecords: number;
  readBytes: number;
  totalBytes: number;
}

interface simpleSearch {
  key: any;
  value: any;
  type: string;
}

@Component({
  selector: 'app-collection',
  templateUrl: './collection.component.html',
  styleUrls: ['./collection.component.css'],
})
export class CollectionComponent implements OnInit {
  @Input() database: any;
  @Input() collection: any;
  data: any;
  filter = '';
  ejsonFilter: any;
  loading = false;
  pageIndex = 1;
  showEditor = false;
  documentEditorMode = 'create';
  documentBeingEdited: any;
  searchMode = 'simple';
  searchObj: simpleSearch = {
    key: '',
    value: '',
    type: 'String',
  };
  prompt: string = '';
  showAdvancedSearchForm = false;
  error: { status: boolean; desc: string } = { status: false, desc: '' };
  constructor(
    private API: ApiService,
    private message: NzMessageService,
    private notification: NzNotificationService
  ) { }

  editorOptions = {
    theme: 'vs',
    language: 'json',
    suggest: {
      showIcons: false,
    },
    contextmenu: false,
    codeLens: false,
    renderLineHighlight: 'none',
  };
  code: string = '{}';
  importButton = false;
  importError: any;
  file = '';
  importFile: any;
  importFileFormat: ImportFileFormat | null = null;
  rowData: any;
  importing = false;
  importProgressPercent = 0;
  importProgressText = '';
  importProgressImportedRecords = 0;
  attributes = [];
  isImportVisible = false;
  ignore = false;
  isExportVisible = false;
  exportButton = true;
  exporting = false;
  exportAs = 'json';
  exportData: any;
  exportError: any;
  showAggregationForm = false;
  aggregationPipeline = '[\n  { "$match": {} },\n  { "$limit": 100 }\n]';
  aggregationLimit = 100;
  aggregationRunning = false;
  aggregationError = '';
  aggregationPreview: any;
  aggregationExportAs = 'json';
  count = 0;
  ngOnInit() {
    this.query();
  }
  query() {
    // console.log(this.code, '#####');
    this.loading = true;
    this.API.filterDocumentsByQuery(
      this.database,
      this.collection,
      this.ejsonFilter || EJSON.serialize({}),
      this.pageIndex,
      this.searchMode,
      this.prompt,
    )
      .subscribe((documents: any) => {
        this.data = EJSON.deserialize(documents);
        this.count = this.data.count;      
        if (this.searchMode === 'advanced') this.closeAdvancedSearchForm();
        if (this.searchMode === 'prompt' && this.prompt) {
          this.filter = JSON.stringify(this.data.query);
          this.showAdvancedSearchForm = !this.showAdvancedSearchForm;
        }
      }, (err) => {
        console.log(err);
      })
      .add(() => {
        this.loading = false;
      });
  }
  getQuery() {
    if (this.searchMode === 'simple') {
      if (!this.searchObj.key) return '{}';
      let key = this.searchObj.key;
      let value = this.searchObj.value;
      if (this.searchObj.type === 'ObjectId' && ObjectId.isValid(value))
        value = { $oid: value };
      if (this.searchObj.type === 'Date') value = { $date: value };
      if (this.searchObj.type === 'Number') value = { $numberInt: value };
      if (this.searchObj.type === 'Boolean') {
        if (value === 'true') value = true;
        else {
          value = false;
          this.searchObj.value = 'false';
        }
      }
      return JSON.stringify({ [key]: value });
    } else return this.filter;
  }

  async handlePromptQuery() {
    if (!this.prompt) return;
    try {
      this.loading = true;
      this.API.getQueryFromPrompt(this.database, this.collection, this.prompt).subscribe((query:string) => {
        this.filter = JSON.stringify(query);
        this.searchMode = 'advanced';
        this.openAdvancedSearchForm();
        this.loading = false;
      });
    } catch {
      this.loading = false;
    }
  }

  uiQuery() {
    if (this.searchMode === 'prompt') {
      this.handlePromptQuery();
      return;
    }
    this.pageIndex = 1;
    this.filter = this.getQuery() || '{}';
    try {
      this.ejsonFilter = EJSON.serialize(JSON.parse(this.filter));
    } catch (err) {
      alert('Invalid query');
    }
    this.query();
  }

  clearFilter() {
    this.filter = '';
    this.ejsonFilter = EJSON.serialize({});
    this.searchObj = {
      key: '',
      value: '',
      type: 'String',
    };
    this.prompt = '';
    this.query();
  }

  deleteDocument(doc) {
    this.API.deleteDocumentById(
      this.database,
      this.collection,
      EJSON.serialize(_.pick(doc, '_id'))
    ).subscribe(() => {
      try {
        this.API.getDocumentCount(
          this.database,
          this.collection,
          this.filter ? JSON.parse(this.filter) : {}
        ).subscribe((res: any) => {
          this.message.info('Deleted!');
          this.data = EJSON.deserialize(res);
          if (this.pageIndex * 10 >= this.data.count)
            this.pageIndex = Math.ceil(this.data.count / 10);
          if (this.data.count === 0) this.pageIndex = 1;
          this.query();
        });
      } catch (err) {
        alert('Invalid JSON query!!');
        this.loading = false;
      }
    });
  }

  updateDocument() {
    try {
      this.error.status = false;
      this.error.desc = '';
      const originalDocument = EJSON.serialize(
        JSON.parse(this.documentBeingEdited)
      );
      // const method = this.documentEditorMode === 'create' ? this.API.createDocument : this.API.updateDocument
      this.API.createDocuments(
        this.database,
        this.collection,
        originalDocument
      ).subscribe((response) => {
        try {
          if (!response['nUpserted']) {
            this.closeEditor();
            this.message.success('Success!');
            this.query();
            return;
          }
          this.API.getDocumentCount(
            this.database,
            this.collection,
            this.filter ? JSON.parse(this.filter) : {}
          ).subscribe((res: any) => {
            this.closeEditor();
            this.message.success('Success!');
            this.data = EJSON.deserialize(res);
            this.pageIndex = Math.ceil(this.data.count / 10);
            if (this.data.count === 0) this.pageIndex = 1;
            this.query();
          });
        } catch (err) {
          alert('Invalid JSON query!!');
          this.loading = false;
        }
      });
    } catch (err) {
      this.error.status = true;
      this.error.desc = err;
    }
  }

  openEditor(doc, mode): void {
    this.documentEditorMode = mode || 'create';
    this.showEditor = true;
    this.documentBeingEdited = JSON.stringify(
      EJSON.serialize(doc),
      undefined,
      4
    );
  }

  closeEditor(): void {
    this.showEditor = false;
    this.documentBeingEdited = '';
  }

  openAdvancedSearchForm() {
    this.showAdvancedSearchForm = true;
  }

  closeAdvancedSearchForm() {
    this.showAdvancedSearchForm = false;
  }

  copyToClipboard(text: any, type: string) {
    text = JSON.stringify((type === 'BSON') ? EJSON.serialize(text) : text);
    const txtArea = document.createElement('textarea');
    txtArea.style.position = 'fixed';
    txtArea.style.top = '0';
    txtArea.style.left = '0';
    txtArea.style.opacity = '0';
    txtArea.value = text;
    document.body.appendChild(txtArea);
    txtArea.select();
    try {
      const result = document.execCommand('copy');
      if (result) {
        this.message.success('Copied!');
      }
    } catch (err) { }
    document.body.removeChild(txtArea);
  }

  beforeUpload = (file: any): boolean => {
    this.importError = '';
    this.attributes = [];
    this.rowData = [];
    this.importButton = false;
    this.importFile = null;
    this.importFileFormat = null;
    this.resetImportProgress();
    const sourceFile = file.originFileObj || file;
    const fileName = file.name || sourceFile.name || '';
    const fileFormat = getImportFileFormat({
      name: fileName,
      type: sourceFile.type || file.type,
    });

    if (fileFormat === 'zip') {
      this.message.error('Extract the database ZIP first, then import a JSON or CSV collection file.');
      this.importing = false;
      this.file = '';
      return false;
    }
    if (!fileFormat) {
      this.message.error('You can only upload either JSON or CSV files!');
      this.importing = false;
      this.file = '';
      return false;
    }
    this.file = fileName;
    this.importFile = sourceFile;
    this.importFileFormat = fileFormat;
    try {
      if (fileFormat === 'csv') {
        readFirstTextChunk(sourceFile)
          .then((text) => {
            if (this.file !== fileName) return;
            const keys = _.take(getCsvHeaderFieldsFromText(text), 1500);
            if (!keys.length) throw new Error('The CSV file does not contain a header row.');
            this.attributes = _.map(keys, (key) => ({
              include: true,
              label: key,
              type: 'String',
            }));
            this.rowData = [];
            this.importButton = true;
          })
          .catch((err) => {
            if (this.file !== fileName) return;
            this.importError = formatFileReadError(err);
            this.rowData = [];
            this.importButton = false;
          });
      } else {
        readFirstTextChunk(sourceFile)
          .then((text) => {
            if (this.file !== fileName) return;
            const trimmed = String(text || '').replace(/^\ufeff/, '').trim();
            if (!trimmed) throw new Error('The JSON file is empty.');
            if (trimmed[0] !== '[' && trimmed[0] !== '{') {
              throw new Error('The JSON import file must contain a document or an array of documents.');
            }
            this.rowData = [];
            this.importButton = true;
          })
          .catch((err) => {
            if (this.file !== fileName) return;
            this.importError = formatFileReadError(err);
            this.rowData = [];
            this.importButton = false;
          });
      }
    } catch (err) {
      this.importError = formatFileReadError(err);
      this.rowData = [];
      this.importButton = false;
    }
    return false;
  };

  showImportModal(): void {
    this.isImportVisible = true;
    this.file = '';
    this.importFile = null;
    this.importFileFormat = null;
    this.rowData = [];
    this.importError = '';
    this.importButton = false;
    this.importing = false;
    this.resetImportProgress();
  }

  importRecords(): void {
    if (this.importFileFormat === 'json' && this.importFile) {
      this.importJsonRecords();
      return;
    }
    if (this.importFileFormat === 'csv' && this.importFile) {
      this.importCsvRecords();
      return;
    }

    let records: any = [];
    try {
      if (this.attributes[0]) {
        this.importError = '';
        this.importing = true;
        this.importButton = false;
        for (let row of this.rowData) {
          let record = {};
          for (let attribute of this.attributes) {
            if (attribute.include) {
              if (_.get(row, attribute.label)) {
                switch (attribute.type) {
                  case 'ObjectId':
                    row[attribute.label] = new ObjectId(row[attribute.label]);
                    break;

                  case 'Boolean':
                    row[attribute.label] = Boolean(row[attribute.label]);
                    break;

                  case 'Date':
                    row[attribute.label] = { $date: row[attribute.label] };
                    break;

                  case 'Number':
                    row[attribute.label] = { $numberInt: row[attribute.label] };
                    break;

                  default:
                    row[attribute.label] = String(row[attribute.label]);
                    break;
                }
                _.set(record, attribute.label, row[attribute.label]);
              }
            }
          }
          if (this.importing) {
            records.push(record);
            this.importError = '';
          } else {
            records = [];
            break;
          }
        }
      } else {
        records = this.rowData;
        this.importError = '';
        this.importing = true;
        this.importButton = false;
      }
      if (!this.importError) {
        const originalDocument = EJSON.serialize(
          typeof records === 'string' ? JSON.parse(records) : records
        );
        this.API.createDocuments(
          this.database,
          this.collection,
          originalDocument
        ).subscribe((response) => {
          this.importing = false;
          this.importButton = false;
          if (!response['nUpserted']) {
            this.message.success('Success!');
            this.query();
            this.closeImportModal();
            return;
          }
          this.API.getDocumentCount(
            this.database,
            this.collection,
            this.filter ? JSON.parse(this.filter) : {}
          ).subscribe((res: any) => {
            this.message.success('Success!');
            this.closeImportModal();
            this.data = EJSON.deserialize(res);
            this.pageIndex = Math.ceil(this.data.count / 10);
            this.query();
          }, (error) => {
            this.importError = error;
            this.importButton = true;
            this.importing = false;
          });
        }, (error) => {
          this.importError = error;
          this.importButton = true;
          this.importing = false;
        });
      }
    } catch (err) {
      this.importError = err.message;
      this.importButton = true;
      this.importing = false;
    }
  }

  private beginImport(): void {
    this.importError = '';
    this.importing = true;
    this.importButton = false;
    this.resetImportProgress();
  }

  private finishImportSuccess(importedRecords: number): void {
    this.importProgressPercent = 100;
    this.importProgressText = `Imported ${importedRecords} records`;
    this.importProgressImportedRecords = importedRecords;
    this.importing = false;
    this.importButton = false;
    this.message.success(`Success! Imported ${importedRecords} records.`);
    this.query();
    this.closeImportModal();
  }

  private finishImportError(err: any): void {
    this.importError = formatFileReadError(err);
    this.importButton = true;
    this.importing = false;
  }

  private resetImportProgress(): void {
    this.importProgressPercent = 0;
    this.importProgressText = '';
    this.importProgressImportedRecords = 0;
  }

  private createImportState(): ImportState {
    return {
      batch: [],
      bytes: 0,
      importedRecords: 0,
      confirmedRecords: 0,
      readBytes: 0,
      totalBytes: this.importFile && this.importFile.size ? this.importFile.size : 0,
    };
  }

  private updateImportProgress(state: ImportState, readBytes?: number, complete = false): void {
    if (typeof readBytes === 'number') {
      state.readBytes = Math.max(state.readBytes, Math.min(readBytes, state.totalBytes || readBytes));
    }

    this.importProgressPercent = calculateImportProgressPercent(
      state.totalBytes,
      state.readBytes,
      complete
    );
    this.importProgressImportedRecords = state.confirmedRecords;

    if (complete) {
      this.importProgressText = `Imported ${state.confirmedRecords} records`;
    } else if (state.confirmedRecords) {
      this.importProgressText = `Imported ${state.confirmedRecords} records`;
    } else if (state.readBytes) {
      this.importProgressText = 'Reading file';
    } else {
      this.importProgressText = 'Preparing import';
    }
  }

  private createDocumentsBatch(records: any[], state?: ImportState): Promise<any> {
    if (!records.length) return Promise.resolve();
    const recordCount = records.length;
    return this.API.createDocuments(
      this.database,
      this.collection,
      EJSON.serialize(records)
    ).toPromise().then((response) => {
      if (state) {
        state.confirmedRecords += recordCount;
        this.updateImportProgress(state);
      }
      return response;
    });
  }

  private async queueImportRecord(record: any, state: ImportState): Promise<void> {
    const recordBytes = JSON.stringify(record).length;
    if (
      state.batch.length &&
      (state.batch.length >= IMPORT_BATCH_SIZE || state.bytes + recordBytes > IMPORT_BATCH_BYTES)
    ) {
      await this.flushImportState(state);
    }
    state.batch.push(record);
    state.bytes += recordBytes;
    state.importedRecords += 1;
  }

  private async flushImportState(state: ImportState): Promise<void> {
    if (!state.batch.length) return;
    const batch = state.batch;
    state.batch = [];
    state.bytes = 0;
    await this.createDocumentsBatch(batch, state);
  }

  private async importJsonRecords(): Promise<void> {
    this.beginImport();
    const state = this.createImportState();
    this.updateImportProgress(state);

    try {
      const firstChunk = await readFirstTextChunk(this.importFile, 4096);
      const trimmed = String(firstChunk || '').replace(/^\ufeff/, '').trim();
      if (!trimmed) throw new Error('The JSON file is empty.');

      if (trimmed[0] === '{') {
        const documentText = await readBlobAsText(this.importFile);
        this.updateImportProgress(state, state.totalBytes);
        await this.queueImportRecord(JSON.parse(documentText), state);
      } else {
        for await (const record of readJsonFileRecords(this.importFile, undefined, (bytesRead) => {
          this.updateImportProgress(state, bytesRead);
        })) {
          await this.queueImportRecord(record, state);
        }
      }

      await this.flushImportState(state);
      if (!state.importedRecords) throw new Error('No records found in file.');
      this.updateImportProgress(state, state.totalBytes, true);
      this.finishImportSuccess(state.importedRecords);
    } catch (err) {
      this.finishImportError(err);
    }
  }

  private convertCsvRowToRecord(row: any): any {
    let record = {};
    for (let attribute of this.attributes) {
      if (!attribute.include) continue;
      const rowValue = _.get(row, attribute.label);
      if (rowValue === null || typeof rowValue === 'undefined' || rowValue === '') continue;

      let value;
      switch (attribute.type) {
        case 'ObjectId':
          value = new ObjectId(rowValue);
          break;

        case 'Boolean':
          value = String(rowValue).toLowerCase() === 'true';
          break;

        case 'Date':
          value = { $date: rowValue };
          break;

        case 'Number':
          value = { $numberInt: rowValue };
          break;

        default:
          value = String(rowValue);
          break;
      }
      _.set(record, attribute.label, value);
    }
    return record;
  }

  private async importCsvRows(rows: any[], state: ImportState): Promise<void> {
    for (const row of rows) {
      await this.queueImportRecord(this.convertCsvRowToRecord(row), state);
    }
  }

  private importCsvRecords(): void {
    this.beginImport();
    const state = this.createImportState();
    this.updateImportProgress(state);

    new Promise((resolve, reject) => {
      let failed = false;
      Papa.parse(this.importFile, {
        header: true,
        skipEmptyLines: true,
        chunk: (result, parser) => {
          parser.pause();
          const csvParseError = getCsvParseError(result, { requireFields: false });
          if (csvParseError) {
            failed = true;
            parser.abort();
            reject(new Error(csvParseError));
            return;
          }
          if (result.meta && typeof result.meta.cursor === 'number') {
            this.updateImportProgress(state, result.meta.cursor);
          }
          this.importCsvRows(result.data || [], state)
            .then(() => {
              if (!failed) parser.resume();
            })
            .catch((err) => {
              failed = true;
              parser.abort();
              reject(err);
            });
        },
        complete: () => {
          if (failed) return;
          this.updateImportProgress(state, state.totalBytes);
          this.flushImportState(state)
            .then(() => {
              if (!state.importedRecords) throw new Error('No records found in file.');
              resolve();
            })
            .catch(reject);
        },
        error: (err) => {
          failed = true;
          reject(err);
        },
      });
    })
      .then(() => this.finishImportSuccess(state.importedRecords))
      .catch((err) => this.finishImportError(err));
  }

  closeImportModal(): void {
    this.isImportVisible = false;
    this.importing = false;
    this.importFile = null;
    this.importFileFormat = null;
    this.resetImportProgress();
  }

  getExportAttributes(): void {
    this.attributes = [];
    this.API.aggregate(
      this.database,
      this.collection,
      [
        { $match: this.ejsonFilter || EJSON.serialize({}) },
        { $project: { arrayofkeyvalue: { $objectToArray: '$$ROOT' } } },
        { $unwind: '$arrayofkeyvalue' },
        { $group: { _id: null, allkeys: { $addToSet: '$arrayofkeyvalue.k' } } }
      ]
    ).subscribe((documents: any) => {
      const keys = new Set(documents[0].allkeys.sort());
      for (const key of keys) {
        this.attributes.push({
          include: true,
          label: key,
        });
      }
    });
  }

  showExportModal(): void {
    this.isExportVisible = true;
    this.exporting = false;
    this.exportAs = 'json';
    this.exportButton = true;
    this.getExportAttributes();
  }

  closeExportModal(): void {
    this.isExportVisible = false;
    this.exporting = false;
    this.attributes = [];
    this.exportAs = 'json';
    this.exportButton = true;
  }

  getIncludedExportAttributes() {
    return this.attributes
      .filter((attribute) => attribute.include)
      .map((attribute) => attribute.label);
  }

  submitChunkedExport(payload): void {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = this.API.getExportUrl(this.database, this.collection);
    form.target = '_blank';
    form.style.display = 'none';

    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'payload';
    input.value = JSON.stringify(payload);
    form.appendChild(input);

    document.body.appendChild(form);
    form.submit();
    document.body.removeChild(form);
  }

  exportCollectionChunked(): void {
    try {
      this.exporting = true;
      this.submitChunkedExport({
        mode: 'find',
        format: this.exportAs,
        filter: this.ejsonFilter || EJSON.serialize({}),
        fields: this.exportAs === 'csv' ? this.getIncludedExportAttributes() : [],
        batchSize: 1000,
      });
      this.message.info('Chunked export started');
      this.closeExportModal();
    } catch (err) {
      this.exportError = err.message || err;
    } finally {
      this.exporting = false;
      this.exportButton = true;
    }
  }

  exportCollection(): void {
    this.exporting = true;
    this.exportButton = false;
    let excludedAttributes = [], includedAttributes = [];
    for (let attribute of this.attributes) {
      if (!attribute.include)
        excludedAttributes.push(attribute.label);
      else
        includedAttributes.push(attribute.label)
    }
    const query = [
      { $match: this.ejsonFilter || EJSON.serialize({}) },
      { $unset: excludedAttributes }
    ];
    if (!excludedAttributes[0] || this.exportAs !== 'csv') query.pop();
    this.API.aggregate(
      this.database,
      this.collection,
      query
    )
      .subscribe((documents: any) => {
        documents = EJSON.parse(JSON.stringify(documents));
        if (this.exportAs === 'csv') {
          for (let row of documents) {
            for (let attribute of includedAttributes) {
              let rowLabel = _.get(row, attribute);
              if (typeof rowLabel === 'object') _.set(row, attribute, JSON.stringify(rowLabel));
            }
          }
          if (includedAttributes[0])
            documents = Papa.unparse(documents, { columns: includedAttributes });
          else documents = Papa.unparse(documents);
        }
        else documents = JSON.stringify(documents, null, 2);
        var blob = new Blob([documents], { type: 'application/octet-stream' });
        var url = window.URL.createObjectURL(blob);
        var anchor = document.createElement('a');
        anchor.download = `${this.collection}.${this.exportAs}`;
        anchor.href = url;
        anchor.click();
        this.exportButton = true;
        this.exporting = false;
      });
  }

  openAggregationForm(): void {
    this.showAggregationForm = true;
    this.aggregationError = '';
  }

  closeAggregationForm(): void {
    this.showAggregationForm = false;
    this.aggregationRunning = false;
    this.aggregationError = '';
  }

  parseAggregationPipeline() {
    const pipeline = JSON.parse(this.aggregationPipeline || '[]');
    if (!(pipeline instanceof Array)) {
      throw new Error('Aggregation pipeline must be a JSON array');
    }
    return pipeline;
  }

  runAggregation(): void {
    let pipeline;
    try {
      this.aggregationError = '';
      pipeline = EJSON.serialize(this.parseAggregationPipeline());
    } catch (err) {
      this.aggregationError = err.message || err;
      return;
    }

    this.aggregationRunning = true;
    this.API.aggregatePreview(
      this.database,
      this.collection,
      pipeline,
      this.aggregationLimit
    ).subscribe((result: any) => {
      this.aggregationPreview = EJSON.deserialize(result);
    }, (err) => {
      this.aggregationError = err.error || err.message || 'Aggregation failed';
    }).add(() => {
      this.aggregationRunning = false;
    });
  }

  exportAggregationChunked(): void {
    try {
      this.aggregationError = '';
      this.submitChunkedExport({
        mode: 'aggregate',
        format: this.aggregationExportAs,
        pipeline: EJSON.serialize(this.parseAggregationPipeline()),
        batchSize: 1000,
      });
      this.message.info('Chunked aggregation export started');
    } catch (err) {
      this.aggregationError = err.message || err;
    }
  }
}
