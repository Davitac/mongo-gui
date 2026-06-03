import { Component, OnInit } from '@angular/core';
import { ApiService } from './api.service';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { cloneDeep, includes, set } from 'lodash';
import { NzMessageService } from 'ng-zorro-antd/message';
import { EJSON } from 'bson';
import {
  BulkImportFile,
  calculateImportProgressPercent,
  convertCsvRowToRecord,
  createImportAttributes,
  formatFileReadError,
  getCsvHeaderFieldsFromText,
  getCsvParseError,
  readBlobAsText,
  readFirstTextChunk,
  readJsonFileRecords,
  validateBulkImportFiles,
} from './collection/import-file-utils';
import { IMPORT_BATCH_BYTES, IMPORT_BATCH_SIZE } from './collection/import-config';

const Papa = require('papaparse');

interface BulkImportState {
  collectionName: string;
  batch: any[];
  bytes: number;
  importedRecords: number;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
})
export class AppComponent implements OnInit {

  // constrcutor
  constructor(
    private Api: ApiService,
    private fb: FormBuilder,
    private message: NzMessageService
  ) { }
  title = 'ui';
  docs: any;
  activeTabIndex = 0;
  dbs = {
    totalSize: 0,
    databases: [],
  };
  isLoadingDbs = false;
  isInSearchMode = false;
  searchText: string;
  menuData: any;
  stats = {
    databases: 0,
    collections: 0,
    size: 0,
  };
  /* Forms related stuff */
  // Forms
  addDBForm!: FormGroup;
  addTableForm!: FormGroup;
  dropTableForm!: FormGroup;
  dropDataBaseForm!: FormGroup;
  /* tab related operations */
  tabs = [];
  /* collection related operations */
  // create new collection
  addTableLoader = false;
  // drop collection
  dropTableLoader = false;
  // drop database
  dropDataBaseLoader = false;
  // add database
  addDBLoader = false;
  /* methods to open & close Modals */
  addDB = false;
  addTable = false;
  dropTable = false;
  dropDataBase = false;
  exportDataBase = false;
  exportDataBaseLoader = false;
  exportDataBaseAs = 'json';
  exportDataBaseTarget: any;
  databaseExportFrameName = 'mongo-gui-database-export-frame';
  bulkImport = false;
  bulkImportTarget: any;
  bulkImportLoader = false;
  bulkImportError = '';
  bulkImportPlan: BulkImportFile[] = [];
  bulkImportProgressPercent = 0;
  bulkImportProgressText = '';
  bulkImportImportedRecords = 0;
  bulkImportImportedCollections = 0;
  private bulkImportProcessedBytes = 0;
  private bulkImportTotalBytes = 0;
  private bulkImportCurrentFileReadBytes = 0;
  private bulkImportCurrentFileSize = 0;
  active = 'databases';
  db: any;

  /* side-nav */
  getDatabases() {
    this.isLoadingDbs = true;
    this.Api.getDbs()
      .subscribe(
        (res: any) => {
          this.dbs = res;
          this.computeStats();
          this.filter();
          if (this.active === 'collections') this.showCollections(this.db);
        }
      )
      .add(() => {
        this.isLoadingDbs = false;
      });
  }
  reloadSideNav() {
    this.getDatabases();
  }
  computeStats() {
    this.stats.databases = this.dbs.databases.length;
    this.stats.collections = this.dbs.databases.reduce(
      (count, db) => count + db.collections.length,
      0
    );
    this.stats.size = this.dbs.totalSize;
  }

  mustMatch(controlName, matchingControlName) {
    return (formGroup: FormGroup) => {
      const control = formGroup.controls[controlName];
      const matchingControl = formGroup.controls[matchingControlName];
      if (
        matchingControl.errors &&
        !matchingControl.errors.confirmedValidator
      ) {
        return;
      }
      if (control.value !== matchingControl.value) {
        matchingControl.setErrors({ confirmedValidator: true });
      } else {
        matchingControl.setErrors(null);
      }
    };
  }
  initForms() {
    this.addTableForm = this.fb.group({
      database: [null, [Validators.required]],
      collection: [null, [Validators.required]],
    });
    this.addDBForm = this.fb.group({
      database: [null, [Validators.required]],
      collection: [null, [Validators.required]],
    });
    this.dropTableForm = this.fb.group(
      {
        database: [null, [Validators.required]],
        collection: [null, [Validators.required]],
        confirmCollection: [null, [Validators.required]],
      },
      {
        validators: this.mustMatch('collection', 'confirmCollection'),
      }
    );
    this.dropDataBaseForm = this.fb.group(
      {
        database: [null, [Validators.required]],
        confirmDataBase: [null, [Validators.required]],
      },
      {
        validators: this.mustMatch('database', 'confirmDataBase'),
      }
    );
  }
  ngOnInit() {
    this.getDatabases();
    this.initForms();
  }

  expand(e, database) {
    if (includes(e.target.classList, 'collection_item')) return;
    this.closeAllTabs();
    e.stopPropagation();
    e.target.classList.toggle('open');
    this.showCollections(database);
  }

  filter() {
    this.isInSearchMode = true;
    this.menuData = cloneDeep(this.dbs.databases);
    if (!this.searchText) {
      this.isInSearchMode = false;
      return;
    }
    const pattern = new RegExp(`.*${this.searchText}.*`, 'i');
    this.menuData = this.menuData
      .map((db) => {
        db.collections = db.collections.filter((col) => pattern.test(col.name));
        return db;
      })
      .filter((db) => db.collections.length);
  }

  activateTab(index) {
    this.activeTabIndex = index;
  }
  openTab(database, collection) {
    const id = `${database}.${collection}`;
    const tabIndex = this.tabs.findIndex((tab) => tab.id === id);
    if (tabIndex > -1) {
      this.activateTab(tabIndex);
      return;
    }
    this.tabs.push({
      id,
      database,
      collection,
    });
    this.activateTab(this.tabs.length - 1);
  }
  closeTab(id) {
    this.active = 'databases';
    const idx = this.tabs.findIndex((tab) => tab.id === id);
    this.tabs.splice(idx, 1);
    if (this.tabs.length) {
      this.activeTabIndex = this.tabs.length - 1;
    }
  }
  showCollections(database) {
    this.Api.getCollections(database.name)
      .subscribe((res:any) => {
        set(database, 'collections', res);
        this.db = database;
        this.active = 'collections';
      });
  }
  closeTabsByDataBase(database) {
    this.tabs = this.tabs.filter((tab) => tab.database !== database);
  }
  closeAllTabs() {
    this.tabs = [];
  }
  openDashBoard() {
    this.active = 'databases';
    this.closeAllTabs();
  }
  createTable() {
    if (!this.addTableForm.valid) { return; }

    this.addTableLoader = true;

    const body = this.addTableForm.value;
    this.Api.createCollection(body)
      .subscribe(() => {
        this.getDatabases(); // re-renders side nav
        this.openTab(body.database, body.collection);
        this.closeModal('addTable');
      })
      .add(() => {
        this.addTableLoader = false;
      });
  }
  dropCollection() {
    if (!this.dropTableForm.valid) { return; }

    this.dropTableLoader = true;

    const body = this.dropTableForm.value;
    this.Api.dropCollection(body)
      .subscribe(() => {
        this.getDatabases(); // re-render side nav
        this.closeTab(`${body.database}.${body.collection}`);
        this.closeModal('dropTable');
      })
      .add(() => {
        this.dropTableLoader = false;
      });
  }
  dropDB() {
    if (!this.dropDataBaseForm.valid) { return; }

    this.dropDataBaseLoader = true;

    const body = this.dropDataBaseForm.value;
    this.Api.dropDB(body)
      .subscribe(() => {
        this.getDatabases(); // re-render side-nav
        this.closeTabsByDataBase(body.database);
        this.closeModal('dropDataBase');
      })
      .add(() => {
        this.dropDataBaseLoader = false;
      });
  }
  addDataBase() {
    if (!this.addDBForm.valid) { return; }

    this.addDBLoader = true;

    const body = this.addDBForm.value;
    this.Api.createCollection(body)
      .subscribe(() => {
        this.getDatabases(); // re-render side-nav
        this.openTab(body.database, body.collection);
        this.closeModal('addDB');
      })
      .add(() => {
        this.addDBLoader = false;
      });
  }

  private ensureDatabaseExportFrame() {
    let iframe = document.getElementById(this.databaseExportFrameName) as HTMLIFrameElement;
    if (iframe) return iframe;

    iframe = document.createElement('iframe');
    iframe.id = this.databaseExportFrameName;
    iframe.name = this.databaseExportFrameName;
    iframe.style.display = 'none';
    document.body.appendChild(iframe);
    return iframe;
  }

  submitDatabaseExport(payload): void {
    this.ensureDatabaseExportFrame();

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = this.Api.getDatabaseExportUrl(this.exportDataBaseTarget.database);
    form.target = this.databaseExportFrameName;
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

  exportDatabaseChunked(): void {
    if (!this.exportDataBaseTarget || !this.exportDataBaseTarget.database) return;

    try {
      this.exportDataBaseLoader = true;
      this.submitDatabaseExport({
        format: this.exportDataBaseAs,
        batchSize: 1000,
      });
      this.closeModal('exportDataBase');
    } finally {
      this.exportDataBaseLoader = false;
    }
  }

  private getExistingCollectionNamesForDatabase(dbName: string): string[] {
    const databases = this.dbs && this.dbs.databases || [];
    const database = databases.find(db => db.name === dbName);
    return (database && database.collections || []).map(collection => collection.name);
  }

  onBulkImportFilesSelected(event): void {
    const input = event && event.target;
    const files = Array.prototype.slice.call(input && input.files || []);
    this.bulkImportError = '';
    this.resetBulkImportProgress();

    try {
      this.bulkImportPlan = validateBulkImportFiles(
        files,
        this.getExistingCollectionNamesForDatabase(this.bulkImportTarget && this.bulkImportTarget.database)
      );
    } catch (err) {
      this.bulkImportPlan = [];
      this.bulkImportError = formatFileReadError(err);
    }

    if (input) input.value = '';
  }

  private resetBulkImport(): void {
    this.bulkImportPlan = [];
    this.bulkImportError = '';
    this.bulkImportLoader = false;
    this.resetBulkImportProgress();
  }

  private resetBulkImportProgress(): void {
    this.bulkImportProgressPercent = 0;
    this.bulkImportProgressText = '';
    this.bulkImportImportedRecords = 0;
    this.bulkImportImportedCollections = 0;
    this.bulkImportProcessedBytes = 0;
    this.bulkImportTotalBytes = 0;
    this.bulkImportCurrentFileReadBytes = 0;
    this.bulkImportCurrentFileSize = 0;
  }

  private createBulkImportState(collectionName: string): BulkImportState {
    return {
      collectionName,
      batch: [],
      bytes: 0,
      importedRecords: 0,
    };
  }

  private updateBulkImportProgress(collectionName: string, fileReadBytes?: number, complete = false): void {
    if (typeof fileReadBytes === 'number') {
      this.bulkImportCurrentFileReadBytes = Math.max(
        this.bulkImportCurrentFileReadBytes,
        Math.min(fileReadBytes, this.bulkImportCurrentFileSize || fileReadBytes)
      );
    }

    const processedBytes = this.bulkImportProcessedBytes + this.bulkImportCurrentFileReadBytes;
    this.bulkImportProgressPercent = calculateImportProgressPercent(
      this.bulkImportTotalBytes,
      processedBytes,
      complete
    );

    if (complete) {
      this.bulkImportProgressText = `Imported ${this.bulkImportImportedCollections} collections`;
    } else if (collectionName) {
      this.bulkImportProgressText = `Importing ${collectionName}`;
    } else {
      this.bulkImportProgressText = 'Preparing import';
    }
  }

  private createBulkDocumentsBatch(collectionName: string, records: any[], state: BulkImportState): Promise<any> {
    if (!records.length) return Promise.resolve();
    const recordCount = records.length;
    return this.Api.createDocuments(
      this.bulkImportTarget.database,
      collectionName,
      EJSON.serialize(records)
    ).toPromise().then((response) => {
      this.bulkImportImportedRecords += recordCount;
      this.updateBulkImportProgress(state.collectionName);
      return response;
    });
  }

  private async queueBulkImportRecord(record: any, state: BulkImportState): Promise<void> {
    const recordBytes = JSON.stringify(record).length;
    if (
      state.batch.length &&
      (state.batch.length >= IMPORT_BATCH_SIZE || state.bytes + recordBytes > IMPORT_BATCH_BYTES)
    ) {
      await this.flushBulkImportState(state);
    }
    state.batch.push(record);
    state.bytes += recordBytes;
    state.importedRecords += 1;
  }

  private async flushBulkImportState(state: BulkImportState): Promise<void> {
    if (!state.batch.length) return;
    const batch = state.batch;
    state.batch = [];
    state.bytes = 0;
    await this.createBulkDocumentsBatch(state.collectionName, batch, state);
  }

  private createEmptyBulkImportCollection(collectionName: string): Promise<any> {
    return this.Api.createCollection({
      database: this.bulkImportTarget.database,
      collection: collectionName,
    }).toPromise();
  }

  private async finalizeBulkImportState(state: BulkImportState): Promise<number> {
    await this.flushBulkImportState(state);
    if (!state.importedRecords) {
      await this.createEmptyBulkImportCollection(state.collectionName);
    }
    return state.importedRecords;
  }

  private async importBulkJsonFile(plan: BulkImportFile): Promise<number> {
    const state = this.createBulkImportState(plan.collectionName);
    const firstChunk = await readFirstTextChunk(plan.file, 4096);
    const trimmed = String(firstChunk || '').replace(/^\ufeff/, '').trim();
    if (!trimmed) throw new Error(`${plan.file.name} is empty.`);

    if (trimmed[0] === '{') {
      const documentText = await readBlobAsText(plan.file);
      this.updateBulkImportProgress(plan.collectionName, plan.file.size || 0);
      await this.queueBulkImportRecord(JSON.parse(documentText), state);
    } else {
      for await (const record of readJsonFileRecords(plan.file, undefined, (bytesRead) => {
        this.updateBulkImportProgress(plan.collectionName, bytesRead);
      })) {
        await this.queueBulkImportRecord(record, state);
      }
    }

    return this.finalizeBulkImportState(state);
  }

  private async importBulkCsvRows(rows: any[], state: BulkImportState, attributes): Promise<void> {
    for (const row of rows) {
      await this.queueBulkImportRecord(convertCsvRowToRecord(row, attributes), state);
    }
  }

  private async importBulkCsvFile(plan: BulkImportFile): Promise<number> {
    const headerText = await readFirstTextChunk(plan.file);
    const keys = getCsvHeaderFieldsFromText(headerText);
    if (!keys.length) throw new Error(`${plan.file.name} does not contain a header row.`);

    const state = this.createBulkImportState(plan.collectionName);
    const attributes = createImportAttributes(keys);

    await new Promise((resolve, reject) => {
      let failed = false;
      Papa.parse(plan.file, {
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
            this.updateBulkImportProgress(plan.collectionName, result.meta.cursor);
          }
          this.importBulkCsvRows(result.data || [], state, attributes)
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
          this.updateBulkImportProgress(plan.collectionName, plan.file.size || 0);
          this.finalizeBulkImportState(state)
            .then(() => resolve())
            .catch(reject);
        },
        error: (err) => {
          failed = true;
          reject(err);
        },
      });
    });

    return state.importedRecords;
  }

  private async importBulkFile(plan: BulkImportFile): Promise<void> {
    this.bulkImportCurrentFileSize = plan.file && plan.file.size || 0;
    this.bulkImportCurrentFileReadBytes = 0;
    this.updateBulkImportProgress(plan.collectionName);

    if (plan.format === 'json') {
      await this.importBulkJsonFile(plan);
    } else if (plan.format === 'csv') {
      await this.importBulkCsvFile(plan);
    }

    this.bulkImportProcessedBytes += this.bulkImportCurrentFileSize;
    this.bulkImportCurrentFileReadBytes = 0;
    this.bulkImportImportedCollections += 1;
    this.updateBulkImportProgress(plan.collectionName);
  }

  async importDatabaseCollections(): Promise<void> {
    if (!this.bulkImportPlan.length || !this.bulkImportTarget || !this.bulkImportTarget.database) {
      this.bulkImportError = 'Select at least one JSON or CSV file to import.';
      return;
    }

    this.bulkImportLoader = true;
    this.bulkImportError = '';
    this.bulkImportTotalBytes = this.bulkImportPlan.reduce((total, item) => {
      return total + (item.file && item.file.size || 0);
    }, 0);
    this.updateBulkImportProgress('');

    try {
      for (const plan of this.bulkImportPlan) {
        await this.importBulkFile(plan);
      }
      this.updateBulkImportProgress('', undefined, true);
      this.message.success(
        `Imported ${this.bulkImportImportedCollections} collections and ${this.bulkImportImportedRecords} records.`
      );
      const targetDatabase = this.bulkImportTarget.database;
      this.closeModal('bulkImport');
      this.getDatabases();
      this.showCollections({ name: targetDatabase, collections: [] });
    } catch (err) {
      this.bulkImportError = formatFileReadError(err);
    } finally {
      this.bulkImportLoader = false;
    }
  }

  closeModal(title) {
    this[title] = false;
  }

  openModal(title, options) {
    // initializes values
    if (title === 'addTable') {
      this.addTableForm.reset();
      this.addTableForm.controls.database.setValue(options.database);
    }
    if (title === 'addDB') {
      this.addDBForm.reset();
    }
    if (title === 'dropTable') {
      this.dropTableForm.reset();
      this.dropTableForm.controls.database.setValue(options.database);
      this.dropTableForm.controls.collection.setValue(options.collection);
    }
    if (title === 'dropDataBase') {
      this.dropDataBaseForm.reset();
      this.dropDataBaseForm.controls.database.setValue(options.database);
    }
    if (title === 'exportDataBase') {
      this.exportDataBaseTarget = options;
      this.exportDataBaseAs = 'json';
      this.exportDataBaseLoader = false;
    }
    if (title === 'bulkImport') {
      this.bulkImportTarget = options;
      this.resetBulkImport();
    }
    // opens modal
    this[title] = true;
  }
}
