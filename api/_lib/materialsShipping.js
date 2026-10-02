import { getDb } from './db.js';
import { parseCsv } from '../../src/utils/materials.js';

const HEADER_ROW_INDEX = 4;
const APP_ORDER_ID_COLUMN = 19;
const IDENTITY_COLUMNS = Object.freeze({
  order_date: 0,
  due_date: 1,
  manager: 2,
  company: 3,
  phone: 8,
  width: 12,
  depth: 14,
  height: 16,
  quantity: 17,
  color: 18,
});

const SHIPPING_UNAVAILABLE_MESSAGE = '앱 출고 상태를 확인하지 못했습니다. 다시 조회해 주세요.';

export class MaterialsShippingError extends Error {
  constructor(cause) {
    super(SHIPPING_UNAVAILABLE_MESSAGE, cause ? { cause } : undefined);
    this.name = 'MaterialsShippingError';
    this.status = 503;
    this.publicMessage = SHIPPING_UNAVAILABLE_MESSAGE;
  }
}

function normalizeDatePrefix(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})[./-]\s*(\d{1,2})[./-]\s*(\d{1,2})/.exec(text);
  if (!match) return text;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

function normalizeIdentityValue(value, key) {
  if (key === 'order_date' || key === 'due_date') return normalizeDatePrefix(value);
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function normalizeAppOrderId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function identityFromCells(cells, sourceRow) {
  return {
    source_row: sourceRow,
    app_order_id: normalizeAppOrderId(cells[APP_ORDER_ID_COLUMN]),
    values: Object.fromEntries(Object.entries(IDENTITY_COLUMNS)
      .map(([key, column]) => [key, cells[column] ?? ''])),
  };
}

export function parseMaterialsMatchingRows(csv) {
  return parseCsv(csv)
    .slice(HEADER_ROW_INDEX + 1)
    .map((cells, index) => ({ cells, sourceRow: HEADER_ROW_INDEX + 2 + index }))
    .filter(({ cells }) => cells.some(value => String(value ?? '').trim() !== ''))
    .map(({ cells, sourceRow }) => identityFromCells(cells, sourceRow));
}

function fingerprint(values) {
  return JSON.stringify(Object.keys(IDENTITY_COLUMNS)
    .map(key => normalizeIdentityValue(values?.[key], key)));
}

function hasMatchableIdentity(values) {
  return Object.keys(IDENTITY_COLUMNS)
    .some(key => normalizeIdentityValue(values?.[key], key) !== '');
}

function databaseIdentity(row) {
  return {
    order_date: row.order_date,
    due_date: row.due_date,
    manager: row.sales_person,
    company: row.client_name,
    phone: row.phone,
    width: row.width,
    depth: row.depth,
    height: row.height,
    quantity: row.quantity,
    color: row.color,
  };
}

function isAppShipped(row) {
  return row?.status === 'shipped' || row?.status === '출고완료' || Boolean(row?.ship_date);
}

function groupBy(items, keyForItem) {
  const grouped = new Map();
  for (const item of items) {
    const key = keyForItem(item);
    const values = grouped.get(key) ?? [];
    values.push(item);
    grouped.set(key, values);
  }
  return grouped;
}

function cloneOrder(order) {
  return {
    ...order,
    shipping: { ...order.shipping },
    materials: {
      receipt: { ...order.materials.receipt },
      order: { ...order.materials.order },
      arrival: { ...order.materials.arrival },
    },
  };
}

function markOrder(order, match, linkedOrder) {
  const shipping = {
    ...order.shipping,
    app_match: match,
  };
  if (linkedOrder) {
    shipping.app_link = linkedOrder.link;
    if (isAppShipped(linkedOrder.row)) shipping.status = 'complete';
  }
  return { ...order, shipping };
}

async function queryRelevantOrders(db) {
  return db.execute({
    sql: `SELECT id, order_date, due_date, sales_person, client_name,
                 phone, width, depth, height, quantity, color, status, ship_date
          FROM orders`,
    args: [],
  });
}

export async function reconcileMaterialsShipping({
  orders,
  matchingRows,
  getDbImpl = getDb,
  now = Date.now,
}) {
  let rows;
  try {
    const db = getDbImpl();
    rows = (await queryRelevantOrders(db)).rows ?? [];
  } catch (error) {
    throw new MaterialsShippingError(error);
  }

  const publicOrders = orders.map(cloneOrder);
  const publicBySourceRow = new Map(publicOrders.map(order => [order.source_row, order]));
  const directCsvRows = matchingRows.filter(row => row.app_order_id !== null);
  const directCsvById = groupBy(directCsvRows, row => row.app_order_id);
  const databaseById = groupBy(rows, row => Number(row.id));
  const reservedDirectIds = new Set(directCsvRows.map(row => row.app_order_id));
  const resolved = new Map();

  for (const identity of directCsvRows) {
    const csvCandidates = directCsvById.get(identity.app_order_id) ?? [];
    const databaseCandidates = databaseById.get(identity.app_order_id) ?? [];
    if (csvCandidates.length !== 1 || databaseCandidates.length > 1) {
      resolved.set(identity.source_row, { match: 'ambiguous' });
      continue;
    }
    if (databaseCandidates.length === 0) {
      resolved.set(identity.source_row, { match: 'unmatched' });
      continue;
    }
    const row = databaseCandidates[0];
    resolved.set(identity.source_row, { match: 'verified', row, link: 'direct' });
  }

  const legacyRows = matchingRows.filter(row => row.app_order_id === null);
  const matchableCsvRows = matchingRows.filter(row => hasMatchableIdentity(row.values));
  const csvByFingerprint = groupBy(matchableCsvRows, row => fingerprint(row.values));
  const databaseByFingerprint = groupBy(rows, row => fingerprint(databaseIdentity(row)));

  for (const identity of legacyRows) {
    if (!hasMatchableIdentity(identity.values)) {
      resolved.set(identity.source_row, { match: 'unmatched' });
      continue;
    }
    const key = fingerprint(identity.values);
    const csvCandidates = csvByFingerprint.get(key) ?? [];
    const databaseCandidates = databaseByFingerprint.get(key) ?? [];
    if (csvCandidates.length !== 1 || databaseCandidates.length !== 1) {
      resolved.set(identity.source_row, {
        match: csvCandidates.length > 1 || databaseCandidates.length > 1 ? 'ambiguous' : 'unmatched',
      });
      continue;
    }
    const row = databaseCandidates[0];
    if (reservedDirectIds.has(Number(row.id))) {
      resolved.set(identity.source_row, { match: 'ambiguous' });
      continue;
    }
    resolved.set(identity.source_row, { match: 'verified', row, link: 'legacy' });
  }

  let matchedCount = 0;
  let appShippedCount = 0;
  let unmatchedCount = 0;
  let ambiguousCount = 0;
  const reconciledOrders = publicOrders.map(order => {
    const resolution = resolved.get(order.source_row) ?? { match: 'unmatched' };
    const original = publicBySourceRow.get(order.source_row);
    if (resolution.match === 'verified') {
      matchedCount += 1;
      if (isAppShipped(resolution.row)) appShippedCount += 1;
    } else if (resolution.match === 'ambiguous') {
      ambiguousCount += 1;
    } else {
      unmatchedCount += 1;
    }
    return markOrder(original, resolution.match, resolution.match === 'verified' ? resolution : null);
  });

  return {
    orders: reconciledOrders,
    shipping_match: {
      matched_count: matchedCount,
      app_shipped_count: appShippedCount,
      unmatched_count: unmatchedCount,
      ambiguous_count: ambiguousCount,
      unverified_count: unmatchedCount + ambiguousCount,
      checked_at: new Date(now()).toISOString(),
    },
  };
}
