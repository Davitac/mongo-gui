const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');

const documentCtrl = require('../src/controllers/document');

test('middleware assigns a valid ObjectId with the current MongoDB driver', () => {
  const req = {
    body: {},
    params: {},
    query: { incomingType: 'ejson' },
  };
  const res = {
    status(code) {
      return {
        send(message) {
          throw new Error(`${code}: ${message}`);
        },
      };
    },
  };
  let calledNext = false;

  documentCtrl.middleware(req, res, () => {
    calledNext = true;
  });

  assert.equal(calledNext, true);
  assert.ok(req.documentId instanceof ObjectId);
});

test('resolveDocumentId creates ids for imported documents that do not provide _id', () => {
  assert.ok(documentCtrl.resolveDocumentId({ name: 'imported' }) instanceof ObjectId);
  assert.equal(documentCtrl.resolveDocumentId({ _id: null }), null);

  const existing = new ObjectId();
  assert.equal(documentCtrl.resolveDocumentId({ _id: existing }), existing);
});
