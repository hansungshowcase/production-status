import assert from 'node:assert/strict';

export const repairModuleUrl = new URL(
  '../scripts/repair-legacy-sales-person-aliases.js',
  import.meta.url,
);
export const repair = await import(repairModuleUrl);

const NORMALIZER_ALIAS = '\uAE40\uBCF4\uC218';
const ROUTE_ALIAS = '\uC2E0\uC740\uC808';

export const EXPECTED_IDENTITY = Object.freeze({
  database: 'expected_database',
  user: 'expected_user',
  neonProjectId: 'expected_neon_project',
});

export function requiredFunction(name) {
  assert.equal(typeof repair[name], 'function', `${name} export must exist`);
  return repair[name];
}

export function makeRow(id, overrides = {}) {
  return {
    id,
    order_date: '2026-07-01',
    due_date: '2026-07-31',
    sales_person: id % 2 === 0 ? NORMALIZER_ALIAS : ROUTE_ALIAS,
    work_order_image_url: `https://example.invalid/work-order-${id}.jpg`,
    id_type: 'integer',
    order_date_type: 'text',
    due_date_type: 'text',
    sales_person_type: 'text',
    work_order_image_url_type: 'text',
    ...overrides,
  };
}

export function makeRows() {
  return [203, 204, 205, 206, 207, 208].map(id => makeRow(id));
}

function cloneRows(rows) {
  return structuredClone(rows);
}

export function makeStatefulClient({
  initialRows = makeRows(),
  compareAndSetFailureId = null,
  wrongReturnedIdFor = null,
  postflightTransform = rows => rows,
  freshReadTransform = rows => rows,
  commitResponseError = false,
} = {}) {
  const events = [];
  let committedRows = cloneRows(initialRows);
  let transactionRows = null;
  let lockedReadCount = 0;

  return {
    events,
    async query(sql, params = []) {
      const normalizedSql = String(sql).trim().replace(/\s+/g, ' ');
      events.push({
        kind: 'query',
        sql: normalizedSql,
        params: structuredClone(params),
      });

      if (normalizedSql === 'BEGIN') {
        transactionRows = cloneRows(committedRows);
        return { rows: [], rowCount: null };
      }
      if (normalizedSql === 'ROLLBACK') {
        transactionRows = null;
        return { rows: [], rowCount: null };
      }
      if (normalizedSql === 'COMMIT') {
        committedRows = cloneRows(transactionRows);
        transactionRows = null;
        if (commitResponseError) throw new Error('simulated lost COMMIT response');
        return { rows: [], rowCount: null };
      }
      if (normalizedSql.includes('current_database() AS database_name')) {
        return {
          rows: [{
            database_name: EXPECTED_IDENTITY.database,
            user_name: EXPECTED_IDENTITY.user,
            neon_project_id: EXPECTED_IDENTITY.neonProjectId,
          }],
          rowCount: 1,
        };
      }
      if (normalizedSql.includes('FROM orders')) {
        if (normalizedSql.includes('FOR UPDATE')) {
          lockedReadCount += 1;
          const lockedRows = cloneRows(transactionRows);
          const rows = lockedReadCount === 1
            ? lockedRows
            : postflightTransform(lockedRows);
          return { rows, rowCount: rows.length };
        }
        const rows = freshReadTransform(cloneRows(committedRows));
        return { rows, rowCount: rows.length };
      }
      if (normalizedSql.startsWith('UPDATE orders SET sales_person')) {
        const [replacementSalesPerson, id, originalSalesPerson] = params;
        if (id === compareAndSetFailureId) return { rows: [], rowCount: 0 };
        const index = transactionRows.findIndex(row => (
          row.id === id && row.sales_person === originalSalesPerson
        ));
        if (index === -1) return { rows: [], rowCount: 0 };
        transactionRows[index] = {
          ...transactionRows[index],
          sales_person: replacementSalesPerson,
        };
        const returnedId = id === wrongReturnedIdFor ? id + 1000 : id;
        return { rows: [{ id: returnedId }], rowCount: 1 };
      }

      throw new Error('Unexpected SQL in repair test');
    },
  };
}

export async function readPostCommitRows(client) {
  const result = await client.query(
    repair.POST_COMMIT_VERIFY_SQL,
    [repair.REPAIR_ORDER_IDS],
  );
  return result.rows;
}

export function queryEvents(client, prefix) {
  return client.events.filter(event => (
    event.kind === 'query' && event.sql.startsWith(prefix)
  ));
}

export function applyRepair(client, overrides = {}) {
  return requiredFunction('runRepairTransaction')({
    client,
    mode: 'apply',
    expectedIdentity: EXPECTED_IDENTITY,
    writeRollbackManifest: async () => {
      client.events.push({ kind: 'manifest-write' });
      return 'restricted-manifest.json';
    },
    readPostCommitRows: () => readPostCommitRows(client),
    ...overrides,
  });
}
