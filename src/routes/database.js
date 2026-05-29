const express = require('express');
const router = express.Router({ mergeParams: true });

const commonCtrl = require('../controllers/common');
const databaseExportCtrl = require('../controllers/databaseExport');
const collectionsRoute = require('./collection');

// collection middleware
router.use('/:dbName/collections', collectionsRoute);

// returns all the databases available
router.get('/', commonCtrl.listDatabases);

// cursor-based database export
router.post('/:dbName/export', databaseExportCtrl.exportDatabase);

// drops database
router.delete('/:dbName', commonCtrl.dropDB);

module.exports = router;
