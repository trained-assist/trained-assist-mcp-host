'use strict';

const { DatabaseSync } = require('node:sqlite');
const { readFileSync } = require('node:fs');
const path = require('node:path');

function createFakeD1() {
  const db = new DatabaseSync(':memory:');
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind: (...args) => ({
          run: async () => {
            const r = stmt.run(...args);
            return { meta: { changes: Number(r.changes) } };
          },
          get: async () => stmt.get(...args),
          first: async () => stmt.get(...args),
          all: async () => ({ results: stmt.all(...args) }),
        }),
      };
    },
    exec: async (sql) => {
      db.exec(sql);
      return { success: true };
    },
  };
}

async function applyMigrations(fakeD1, migrationFiles) {
  for (const file of migrationFiles) {
    const sql = readFileSync(path.resolve(__dirname, '..', '..', file), 'utf8');
    await fakeD1.exec(sql);
  }
}

module.exports = { createFakeD1, applyMigrations };