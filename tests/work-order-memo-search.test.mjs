import assert from 'node:assert/strict';
import test from 'node:test';
import { handleGet } from '../api/orders/index.js';

async function captureSearch(query) {
  const statements = [];
  const db = {
    async execute(statement) {
      statements.push(statement);
      return { rows: statements.length === 1 ? [] : [{ count: 0 }] };
    },
  };
  await handleGet({ query }, { json: (body) => body }, db);
  return statements;
}

test('work-order memo search includes every memo field in both list and total filters', async () => {
  const statements = await captureSearch({ search: '한성', search_mode: 'work_order' });
  assert.equal(statements.length, 2);
  for (const { sql, args } of statements) {
    const filter = sql.slice(sql.indexOf('WHERE 1=1'));
    for (const column of ['notes', 'remarks', 'etc_notes']) {
      assert.ok(filter.includes(`o.${column} LIKE ? ESCAPE`), `${column} must be searched in list and total`);
      assert.ok(filter.includes(`COALESCE(o.${column}, '')`), `${column} must support normalized work-order search`);
    }
    assert.ok(args.includes('%한성%'));
    assert.equal((sql.match(/\?/g) || []).length, args.length);
  }
  assert.deepEqual(statements[0].args.slice(0, -2), statements[1].args);
});

test('work-order memo search preserves existing filters, escaped literals and pagination', async () => {
  const statements = await captureSearch({
    search: '50%_\\', search_mode: 'work_order', sales_person: '신은철',
    status: 'in_production', limit: '12', offset: '24',
  });
  for (const { sql, args } of statements) {
    assert.ok(sql.includes('AND o.sales_person = ?'));
    assert.ok(sql.includes("AND o.status = 'in_production'"));
    assert.ok(sql.includes('CAST(o.id AS TEXT) LIKE ?'));
    assert.equal(args[0], '신은철');
    assert.ok(args.includes('%50\\%\\_\\\\%'));
    assert.equal((sql.match(/\?/g) || []).length, args.length);
  }
  assert.ok(statements[0].sql.endsWith('ORDER BY o.id DESC LIMIT ? OFFSET ?'));
  assert.deepEqual(statements[0].args.slice(-2), [12, 24]);
  assert.deepEqual(statements[0].args.slice(0, -2), statements[1].args);
});
