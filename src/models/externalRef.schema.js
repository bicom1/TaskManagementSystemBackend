const mongoose = require('mongoose');

/**
 * Where a record was imported from, e.g. { source: 'clickup', id: '86c3n2abc' }.
 * Set only on imported documents. Lets an import skip what it already brought in
 * (safe to re-run) and keeps a trace back to the original system.
 */
const externalRefSchema = new mongoose.Schema(
  {
    source: { type: String, required: true, trim: true },
    id: { type: String, required: true, trim: true },
  },
  { _id: false }
);

/** One document per external id, per source — only indexes imported documents. */
function indexExternalRef(schema) {
  schema.index(
    { 'external.source': 1, 'external.id': 1 },
    { unique: true, partialFilterExpression: { 'external.id': { $type: 'string' } } }
  );
}

module.exports = { externalRefSchema, indexExternalRef };
