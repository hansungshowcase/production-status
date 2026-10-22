import assert from 'node:assert/strict';
import test from 'node:test';
import { handleGet } from '../api/orders/index.js';

const GENERAL_COLUMNS = [
  'CAST(o.id AS TEXT)',
  'o.client_name', 'o.product_type', 'o.door_type', 'o.sales_person',
  'o.phone', 'o.color', 'o.design', 'o.notes', 'o.remarks', 'o.etc_notes',
  'o.lead_source', 'o.order_date', 'o.due_date', 'o.ship_scheduled_date',
  'o.work_order_image_url',
  'CAST(o.width AS TEXT)', 'CAST(o.depth AS TEXT)', 'CAST(o.height AS TEXT)',
  'CAST(o.quantity AS TEXT)',
];

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

test('general search adds field-local NFC and explicit whitespace removal with list/count parity', async () => {
  // Given: the persisted order 586 client-name fixture includes spaces.
  const order586ClientName = '이온 플라워 스튜디오';
  const decomposedQuery = '이온플라워';

  // When: the same client name is searched without spaces and with decomposed Hangul input.
  const statements = await captureSearch({ search: decomposedQuery, limit: '12', offset: '24' });

  // Then: every original LIKE remains and every field gets its own normalized auxiliary LIKE.
  assert.equal(order586ClientName.normalize('NFC').replace(/[ \t\n\r\f\v\u00a0\u3000]/g, ''), '이온플라워스튜디오');
  assert.equal(statements.length, 2);
  for (const { sql, args } of statements) {
    for (const column of GENERAL_COLUMNS) {
      assert.ok(sql.includes(`${column} LIKE ? ESCAPE '\\'`), `${column} must retain the original LIKE`);
      assert.ok(sql.includes(`normalize(COALESCE(${column}, ''), NFC)`), `${column} must be normalized independently`);
    }
    assert.ok(sql.includes("E' \\t\\n\\r\\f\\u000B\\u00A0\\u3000'"));
    assert.doesNotMatch(sql, /concat_ws|lower\s*\(/);
    assert.equal(args.filter((value) => value === `%${decomposedQuery}%`).length, GENERAL_COLUMNS.length);
    assert.equal(args.filter((value) => value === '%이온플라워%').length, GENERAL_COLUMNS.length);
    assert.equal((sql.match(/\?/g) || []).length, args.length);
  }
  assert.deepEqual(statements[0].args.slice(0, -2), statements[1].args);
  assert.deepEqual(statements[0].args.slice(-2), [12, 24]);
});

test('general normalized search escapes percent underscore and backslash after removing only approved whitespace', async () => {
  // Given: the query mixes every approved whitespace code point with LIKE metacharacters.
  const search = 'A \tB\nC\rD\fE\vF\u00a0G\u3000%_\\';

  // When: the general search statements are generated.
  const statements = await captureSearch({ search });

  // Then: original and normalized patterns are independently escaped in list and count.
  const originalPattern = `%A \tB\nC\rD\fE\vF\u00a0G\u3000\\%\\_\\\\%`;
  const normalizedPattern = '%ABCDEFG\\%\\_\\\\%';
  for (const { args } of statements) {
    assert.equal(args.filter((value) => value === originalPattern).length, GENERAL_COLUMNS.length);
    assert.equal(args.filter((value) => value === normalizedPattern).length, GENERAL_COLUMNS.length);
  }
  assert.deepEqual(statements[0].args.slice(0, -2), statements[1].args);
});

test('general search omits the auxiliary predicate when approved whitespace normalizes to empty', async () => {
  // Given: the query contains only the approved removable whitespace characters.
  const search = ' \t\n\r\f\v\u00a0\u3000';

  // When: the general search statements are generated.
  const statements = await captureSearch({ search });

  // Then: the original per-column LIKE remains without an empty auxiliary match.
  for (const { sql, args } of statements) {
    assert.doesNotMatch(sql, /normalize\(COALESCE/);
    assert.equal(args.filter((value) => value === `%${search}%`).length, GENERAL_COLUMNS.length);
  }
  assert.deepEqual(statements[0].args.slice(0, -2), statements[1].args);
});

test('work-order search keeps its existing compact cross-field behavior', async () => {
  // Given: a work-order search that uses the existing normalization branch.
  // When: its list and count statements are generated.
  const statements = await captureSearch({ search: '이온 플라워', search_mode: 'work_order' });

  // Then: the general field-local normalization is absent and work-order compact matching remains.
  for (const { sql } of statements) {
    assert.match(sql, /regexp_replace\(lower\(concat_ws/);
    assert.doesNotMatch(sql, /normalize\(COALESCE/);
  }
  assert.deepEqual(statements[0].args.slice(0, -2), statements[1].args);
});
