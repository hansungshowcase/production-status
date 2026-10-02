const HEADER_ROW_INDEX = 4;

const REQUIRED_HEADERS = Object.freeze([
  { index: 0, column: 'A', label: '발주일' },
  { index: 1, column: 'B', label: '납기일' },
  { index: 2, column: 'C', label: '담당' },
  { index: 3, column: 'D', label: '거래처' },
  { index: 4, column: 'E', label: '출고완료일' },
  { index: 32, column: 'AG', label: '자재발주서수취' },
  { index: 33, column: 'AH', label: '자재발주완료' },
  { index: 34, column: 'AI', label: '자재입고완료' },
]);

const STAGE_TOKENS = Object.freeze({
  receipt: new Set(['완료', '수취', '수취완료', '발주서수취', '자재발주서수취']),
  order: new Set(['완료', '발주완료', '자재발주완료']),
  arrival: new Set(['완료', '입고완료', '자재입고완료', '자재전체입고완료']),
});

const CHECK_TOKENS = new Set(['o', '○', 'check', 'true']);
const KOREAN_COLLATOR = new Intl.Collator('ko-KR');
const ORDER_DATE_PATTERN = /^(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})$/;

function normalizeHeader(value) {
  return String(value ?? '').replace(/\s+/g, '');
}

function daysInMonthWithoutYear(month) {
  if (month === 2) return 29;
  if ([4, 6, 9, 11].includes(month)) return 30;
  return 31;
}

function isValidDateParts(year, month, day) {
  if (month < 1 || month > 12 || day < 1) return false;
  if (year === null) return day <= daysInMonthWithoutYear(month);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function isValidSheetDate(value) {
  const text = String(value ?? '').trim();
  const fullDate = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (fullDate) {
    return isValidDateParts(Number(fullDate[1]), Number(fullDate[2]), Number(fullDate[3]));
  }

  const monthDay = /^(\d{1,2})[/.](\d{1,2})$/.exec(text);
  if (!monthDay) return false;
  return isValidDateParts(null, Number(monthDay[1]), Number(monthDay[2]));
}

/**
 * Order dates have a deliberately narrower parser than material-stage dates.
 * The sheet contains yearless values such as "7. 2"; those are useful source
 * text but cannot be placed safely in the rolling date window.
 */
export function parseOrderDate(value) {
  const text = String(value ?? '').trim();
  const match = ORDER_DATE_PATTERN.exec(text);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidDateParts(year, month, day)) return null;

  return {
    year,
    month,
    day,
    key: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

function resolveDateKey(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return parseOrderDate(text)?.key ?? null;
  }
  return getKstDateKey(value);
}

function dateOrdinal(dateKey) {
  const parsed = parseOrderDate(dateKey);
  if (!parsed) return null;
  return Date.UTC(parsed.year, parsed.month - 1, parsed.day) / 86400000;
}

export function getCalendarDayDifference(laterDateKey, earlierDateKey) {
  const later = dateOrdinal(laterDateKey);
  const earlier = dateOrdinal(earlierDateKey);
  if (later === null || earlier === null) return null;
  return later - earlier;
}

export function subtractCalendarDays(dateKey, days) {
  const ordinal = dateOrdinal(dateKey);
  if (ordinal === null || !Number.isInteger(days)) return null;
  return new Date((ordinal - days) * 86400000).toISOString().slice(0, 10);
}

/**
 * Due dates are compared using calendar dates only. A due date is never
 * shifted by a guessed year or by a delivery lead-time adjustment.
 */
export function classifyDueDate(order, anchor, resolvedAnchor = resolveDateKey(anchor)) {
  const raw = order?.due_date ?? '';
  const text = String(raw).trim();
  if (!text) {
    return { status: 'needs_review', category: 'due_review', reason: '미기재', raw, date_key: null, days: null };
  }

  const dueDate = parseOrderDate(text);
  if (!dueDate) {
    return { status: 'needs_review', category: 'due_review', reason: '날짜형식', raw, date_key: null, days: null };
  }

  const orderDate = parseOrderDate(order?.order_date);
  if (orderDate && dueDate.key < orderDate.key) {
    return {
      status: 'needs_review',
      category: 'due_review',
      reason: '발주일이전',
      raw,
      date_key: dueDate.key,
      order_date_key: orderDate.key,
      days: null,
    };
  }

  const anchorDateKey = resolvedAnchor;
  if (!anchorDateKey) {
    return {
      status: 'needs_review',
      category: 'due_review',
      reason: '조회기준일미기재',
      raw,
      date_key: dueDate.key,
      order_date_key: orderDate?.key ?? null,
      days: null,
    };
  }

  const difference = getCalendarDayDifference(dueDate.key, anchorDateKey);
  if (difference === null) {
    return {
      status: 'needs_review',
      category: 'due_review',
      reason: '조회기준일미기재',
      raw,
      date_key: dueDate.key,
      order_date_key: orderDate?.key ?? null,
      days: null,
    };
  }
  if (difference < 0) {
    return {
      status: 'overdue',
      category: 'overdue',
      reason: '납기경과',
      raw,
      date_key: dueDate.key,
      order_date_key: orderDate?.key ?? null,
      days: Math.abs(difference),
    };
  }
  if (difference === 0) {
    return {
      status: 'today',
      category: 'today',
      reason: '오늘납기',
      raw,
      date_key: dueDate.key,
      order_date_key: orderDate?.key ?? null,
      days: 0,
    };
  }
  return {
    status: 'future',
    category: 'other',
    reason: '납기예정',
    raw,
    date_key: dueDate.key,
    order_date_key: orderDate?.key ?? null,
    days: difference,
  };
}

export function summarizeDueOrders(orders, anchor, resolvedAnchor = resolveDateKey(anchor)) {
  const hasAnchor = Boolean(resolvedAnchor);
  const details = orders.map(order => classifyDueDate(order, anchor, resolvedAnchor));
  const counts = {
    overdue_count: details.filter(item => item.status === 'overdue').length,
    today_count: details.filter(item => item.status === 'today').length,
    future_count: details.filter(item => item.status === 'future').length,
    due_review_count: hasAnchor
      ? details.filter(item => item.status === 'needs_review').length
      : 0,
  };
  const validDates = details
    .filter(item => ['overdue', 'today', 'future'].includes(item.status))
    .map(item => item.date_key)
    .sort();

  return {
    enabled: hasAnchor,
    counts,
    details,
    earliest_due_date: validDates[0] ?? null,
    valid_due_count: validDates.length,
  };
}

export function classifyMaterialDeadline(order, anchor, resolvedAnchor = resolveDateKey(anchor)) {
  const raw = order?.due_date ?? '';
  const text = String(raw).trim();
  const dueDate = parseOrderDate(text);
  const orderDate = parseOrderDate(order?.order_date);

  if (!text) {
    return {
      status: 'needs_review',
      deadline_state: 'needs_review',
      reason: '미기재',
      raw,
      due_date_key: null,
      deadline_date_key: null,
      days: null,
      started_after_deadline: false,
    };
  }
  if (!dueDate) {
    return {
      status: 'needs_review',
      deadline_state: 'needs_review',
      reason: '날짜형식',
      raw,
      due_date_key: null,
      deadline_date_key: null,
      days: null,
      started_after_deadline: false,
    };
  }
  if (orderDate && dueDate.key < orderDate.key) {
    return {
      status: 'needs_review',
      deadline_state: 'needs_review',
      reason: '발주일이전',
      raw,
      due_date_key: dueDate.key,
      deadline_date_key: null,
      order_date_key: orderDate.key,
      days: null,
      started_after_deadline: false,
    };
  }

  const deadlineDateKey = subtractCalendarDays(dueDate.key, 7);
  const startedAfterDeadline = Boolean(orderDate && deadlineDateKey < orderDate.key);
  if (!resolvedAnchor || !deadlineDateKey) {
    return {
      status: 'needs_review',
      deadline_state: 'needs_review',
      reason: '조회기준일미기재',
      raw,
      due_date_key: dueDate.key,
      deadline_date_key: deadlineDateKey,
      order_date_key: orderDate?.key ?? null,
      days: null,
      started_after_deadline: startedAfterDeadline,
    };
  }

  const difference = getCalendarDayDifference(deadlineDateKey, resolvedAnchor);
  const deadlineState = difference < 0 ? 'overdue' : difference === 0 ? 'today' : 'future';
  const arrivalComplete = order?.materials?.arrival?.status === 'complete';
  return {
    status: arrivalComplete ? 'arrival_complete' : deadlineState,
    deadline_state: deadlineState,
    reason: deadlineState === 'overdue'
      ? '입고마감경과'
      : deadlineState === 'today' ? '오늘입고마감' : '입고마감예정',
    raw,
    due_date_key: dueDate.key,
    deadline_date_key: deadlineDateKey,
    order_date_key: orderDate?.key ?? null,
    days: Math.abs(difference),
    started_after_deadline: startedAfterDeadline,
  };
}

export function summarizeMaterialDeadlines(orders, anchor, resolvedAnchor = resolveDateKey(anchor)) {
  const details = orders.map(order => classifyMaterialDeadline(order, anchor, resolvedAnchor));
  return {
    enabled: Boolean(resolvedAnchor),
    details,
    counts: {
      overdue_count: details.filter(item => item.deadline_state === 'overdue').length,
      today_count: details.filter(item => item.deadline_state === 'today').length,
      future_count: details.filter(item => item.deadline_state === 'future').length,
      review_count: details.filter(item => item.deadline_state === 'needs_review').length,
    },
  };
}

export function getKstDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function getMaterialDateRange(fetchedAt) {
  const end = getKstDateKey(fetchedAt);
  if (!end) return null;

  const [year, month, day] = end.split('-').map(Number);
  const zeroBasedMonth = month - 1 - 3;
  const startYear = year + Math.floor(zeroBasedMonth / 12);
  const startMonth = ((zeroBasedMonth % 12) + 12) % 12 + 1;
  const startDay = Math.min(day, daysInMonth(startYear, startMonth));
  const start = `${String(startYear).padStart(4, '0')}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
  return { start, end };
}

export function normalizeMaterialStatus(value, stage) {
  const text = String(value ?? '').trim();
  if (!text) return 'unchecked';

  const normalized = text.toLocaleLowerCase('en-US');
  if (CHECK_TOKENS.has(normalized) || isValidSheetDate(text)) return 'complete';
  if (STAGE_TOKENS[stage]?.has(text)) return 'complete';
  return 'needs_review';
}

export function normalizeShippingStatus(value) {
  const text = String(value ?? '').trim();
  if (!text) return 'not_shipped';
  if (isValidSheetDate(text)) return 'complete';
  if (text === '출고완료' || text === '출고 완료') return 'complete';

  const completedWithDate = /^출고완료\s*·\s*(.+)$/.exec(text);
  if (completedWithDate && isValidSheetDate(completedWithDate[1])) return 'complete';
  return 'not_shipped';
}

export function parseCsv(text) {
  const input = String(text ?? '').replace(/^\uFEFF/, '');
  const records = [];
  let record = [];
  let field = '';
  let inQuotes = false;
  let justClosedQuote = false;

  const pushField = () => {
    record.push(field);
    field = '';
    justClosedQuote = false;
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];

    if (inQuotes) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          justClosedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (justClosedQuote && character !== ',' && character !== '\r' && character !== '\n') {
      throw new Error('CSV 형식이 올바르지 않습니다: 인용 셀 뒤에 예상하지 않은 문자가 있습니다.');
    }

    if (character === '"') {
      if (field !== '') {
        throw new Error('CSV 형식이 올바르지 않습니다: 셀 중간의 따옴표입니다.');
      }
      inQuotes = true;
    } else if (character === ',') {
      pushField();
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      pushRecord();
    } else {
      field += character;
    }
  }

  if (inQuotes) {
    throw new Error('CSV 형식이 올바르지 않습니다: 닫히지 않은 인용 셀입니다.');
  }
  if (field !== '' || record.length > 0 || justClosedQuote) pushRecord();
  return records;
}

function validateHeader(records) {
  const header = records[HEADER_ROW_INDEX];
  if (!header) throw new Error('원본 시트의 5행 헤더를 찾을 수 없습니다.');

  for (const requirement of REQUIRED_HEADERS) {
    const actual = normalizeHeader(header[requirement.index]);
    if (actual !== requirement.label) {
      throw new Error(
        `원본 시트 헤더가 예상과 다릅니다: ${requirement.column}열은 ${requirement.label}이어야 합니다.`,
      );
    }
  }
}

function materialStage(raw, stage) {
  return {
    raw,
    status: normalizeMaterialStatus(raw, stage),
  };
}

function toOrder(cells, sourceRow) {
  const shippingRaw = cells[4] ?? '';
  const receiptRaw = cells[32] ?? '';
  const orderRaw = cells[33] ?? '';
  const arrivalRaw = cells[34] ?? '';

  return {
    source_row: sourceRow,
    order_date: String(cells[0] ?? '').trim(),
    due_date: String(cells[1] ?? '').trim(),
    manager: String(cells[2] ?? '').trim(),
    company: String(cells[3] ?? '').trim() || '거래처 미기재',
    product_label: String(cells[10] ?? '').trim(),
    shipping: {
      raw: shippingRaw,
      status: normalizeShippingStatus(shippingRaw),
    },
    materials: {
      receipt: materialStage(receiptRaw, 'receipt'),
      order: materialStage(orderRaw, 'order'),
      arrival: materialStage(arrivalRaw, 'arrival'),
    },
  };
}

export function parseMaterialsCsv(csv) {
  const records = parseCsv(csv);
  validateHeader(records);

  const orders = records
    .slice(HEADER_ROW_INDEX + 1)
    .map((cells, index) => ({ cells, sourceRow: HEADER_ROW_INDEX + 2 + index }))
    .filter(({ cells }) => cells.some(value => String(value ?? '').trim() !== ''))
    .map(({ cells, sourceRow }) => toOrder(cells, sourceRow));

  return { orders };
}

export function scopeMaterialOrders(orders, fetchedAt) {
  const range = getMaterialDateRange(fetchedAt);
  if (!range) {
    return {
      orders: [],
      date_range: null,
      unknown_date_count: orders.length,
      future_date_count: 0,
    };
  }

  let unknownDateCount = 0;
  let futureDateCount = 0;
  const scopedOrders = [];

  for (const order of orders) {
    const parsed = parseOrderDate(order.order_date);
    if (!parsed) {
      unknownDateCount += 1;
      continue;
    }
    if (parsed.key > range.end) {
      futureDateCount += 1;
      continue;
    }
    if (parsed.key < range.start || order.shipping?.status === 'complete') continue;
    scopedOrders.push(order);
  }

  return {
    orders: scopedOrders,
    date_range: range,
    unknown_date_count: unknownDateCount,
    future_date_count: futureDateCount,
  };
}

function matchesMaterialFilter(order, material) {
  const stages = order.materials;
  const values = [stages.receipt, stages.order, stages.arrival];
  switch (material) {
    case 'all':
      return true;
    case 'incomplete':
      return values.some(stage => stage.status !== 'complete');
    case 'needs_review':
      return values.some(stage => stage.status === 'needs_review');
    case 'receipt_incomplete':
      return stages.receipt.status !== 'complete';
    case 'order_incomplete':
      return stages.order.status !== 'complete';
    case 'arrival_incomplete':
      return stages.arrival.status !== 'complete';
    default:
      return true;
  }
}

function matchesShippingFilter(order, shipping) {
  switch (shipping) {
    case 'all':
      return true;
    case 'shipped':
      return order.shipping.status === 'complete';
    case 'exclude_shipped':
    default:
      return order.shipping.status !== 'complete';
  }
}

export function filterMaterialOrders(orders, filters = {}) {
  const query = String(filters.companyQuery ?? '').trim().toLocaleLowerCase('ko-KR');
  const materialFilter = filters.material ?? 'all';
  const hasFixedScope = Boolean(filters.fetchedAt || filters.anchor || filters.anchorDate);
  const sourceOrders = hasFixedScope
    ? scopeMaterialOrders(orders, filters.fetchedAt || filters.anchor || filters.anchorDate).orders
    : orders.filter(order => matchesShippingFilter(order, filters.shipping));
  const companyMatches = new Set(sourceOrders
    .filter(order => matchesMaterialFilter(order, materialFilter))
    .filter(order => !query || order.company.toLocaleLowerCase('ko-KR').includes(query))
    .map(order => order.company));

  return sourceOrders.filter(order => {
    const matchesCompany = !query || order.company.toLocaleLowerCase('ko-KR').includes(query);
    const matchesMaterial = materialFilter === 'all' || companyMatches.has(order.company);
    return matchesCompany && matchesMaterial;
  });
}

function countStages(orders) {
  const stageKeys = ['receipt', 'order', 'arrival'];
  return Object.fromEntries(stageKeys.map(stage => [stage, {
    complete_count: orders.filter(order => order.materials[stage].status === 'complete').length,
    unchecked_count: orders.filter(order => order.materials[stage].status === 'unchecked').length,
    needs_review_count: orders.filter(order => order.materials[stage].status === 'needs_review').length,
    target_order_count: orders.length,
  }]));
}

function materialOrderIncomplete(order) {
  return ['receipt', 'order', 'arrival']
    .some(stage => order.materials[stage].status !== 'complete');
}

function hasRawMaterialReview(order) {
  return ['receipt', 'order', 'arrival']
    .some(stage => order.materials[stage].status === 'needs_review');
}

function isReviewOrder(order, deadline) {
  return deadline.deadline_state === 'needs_review'
    || hasRawMaterialReview(order)
    || order.shipping?.app_match === 'ambiguous';
}

function priorityRankForOrder(order, deadline) {
  const arrivalStatus = order.materials.arrival.status;
  if (arrivalStatus === 'unchecked' && deadline.deadline_state === 'overdue') return 1;
  if (arrivalStatus === 'unchecked' && deadline.deadline_state === 'today') return 2;
  if (isReviewOrder(order, deadline)) return 3;
  if (arrivalStatus === 'unchecked' && deadline.deadline_state === 'future') return 4;
  if (arrivalStatus === 'complete') return 5;
  return 3;
}

function compareRepresentative(left, right, rank) {
  if ([1, 2, 4].includes(rank)) {
    const dateCompare = String(left.deadline.deadline_date_key ?? '9999-12-31')
      .localeCompare(String(right.deadline.deadline_date_key ?? '9999-12-31'));
    if (dateCompare !== 0) return dateCompare;
  }
  if (rank === 5) {
    const dueCompare = String(left.deadline.due_date_key ?? '9999-12-31')
      .localeCompare(String(right.deadline.due_date_key ?? '9999-12-31'));
    if (dueCompare !== 0) return dueCompare;
  }
  return Number(right.source_row ?? 0) - Number(left.source_row ?? 0);
}

function priorityTone(rank) {
  return ({ 1: 'overdue', 2: 'today', 3: 'review', 4: 'future', 5: 'complete' })[rank];
}

function compareCompanySummary(left, right) {
  if (left.priority_rank !== right.priority_rank) return left.priority_rank - right.priority_rank;
  if ([1, 2, 4].includes(left.priority_rank)) {
    const dateCompare = String(left.representative_order.deadline.deadline_date_key ?? '9999-12-31')
      .localeCompare(String(right.representative_order.deadline.deadline_date_key ?? '9999-12-31'));
    if (dateCompare !== 0) return dateCompare;
  }
  if (left.priority_rank === 3) {
    if (left.review_order_count !== right.review_order_count) {
      return right.review_order_count - left.review_order_count;
    }
    if (left.arrival_unconfirmed_count !== right.arrival_unconfirmed_count) {
      return right.arrival_unconfirmed_count - left.arrival_unconfirmed_count;
    }
  }
  if (left.priority_rank === 5) {
    const dueCompare = String(left.earliest_valid_due_date ?? '9999-12-31')
      .localeCompare(String(right.earliest_valid_due_date ?? '9999-12-31'));
    if (dueCompare !== 0) return dueCompare;
  }
  return KOREAN_COLLATOR.compare(left.company, right.company);
}

export function aggregateMaterialOrders(orders, anchor) {
  const resolvedAnchor = resolveDateKey(anchor);
  const grouped = new Map();
  for (const order of orders) {
    const companyOrders = grouped.get(order.company) ?? [];
    companyOrders.push(order);
    grouped.set(order.company, companyOrders);
  }

  const companies = [...grouped.entries()]
    .map(([company, companyOrders]) => {
      const incompleteOrderCount = companyOrders.filter(materialOrderIncomplete).length;
      const decoratedOrders = companyOrders.map(order => {
        const deadline = classifyMaterialDeadline(order, anchor, resolvedAnchor);
        return {
          ...order,
          due: classifyDueDate(order, anchor, resolvedAnchor),
          deadline,
          priority_rank: priorityRankForOrder(order, deadline),
        };
      });
      const priorityRank = Math.min(...decoratedOrders.map(order => order.priority_rank));
      const representativeOrder = decoratedOrders
        .filter(order => order.priority_rank === priorityRank)
        .sort((left, right) => compareRepresentative(left, right, priorityRank))[0];
      const reviewOrderCount = decoratedOrders.filter(order => isReviewOrder(order, order.deadline)).length;
      const arrivalUnconfirmedCount = companyOrders
        .filter(order => order.materials.arrival.status === 'unchecked').length;
      const earliestValidDueDate = decoratedOrders
        .map(order => order.deadline.due_date_key)
        .filter(Boolean)
        .sort()[0] ?? null;
      return {
        company,
        target_order_count: companyOrders.length,
        incomplete_order_count: incompleteOrderCount,
        review_order_count: reviewOrderCount,
        arrival_unconfirmed_count: arrivalUnconfirmedCount,
        all_complete: incompleteOrderCount === 0,
        all_arrival_confirmed: companyOrders.every(order => order.materials.arrival.status === 'complete'),
        stages: countStages(companyOrders),
        priority_rank: priorityRank,
        priority_tone: priorityTone(priorityRank),
        representative_order: representativeOrder,
        earliest_valid_due_date: earliestValidDueDate,
        additional_review_count: priorityRank < 3 ? reviewOrderCount : 0,
        orders: decoratedOrders.sort((left, right) => right.source_row - left.source_row),
      };
    })
    .sort(compareCompanySummary);

  return {
    total_orders: orders.length,
    total_companies: companies.length,
    stages: countStages(orders),
    deadline_counts: summarizeMaterialDeadlines(orders, anchor, resolvedAnchor).counts,
    companies,
  };
}
