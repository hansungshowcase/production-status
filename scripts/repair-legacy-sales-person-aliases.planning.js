import {
  ALLOWED_SALES_PERSONS,
  normalizeOrderMutationInput,
} from '../api/_lib/orderCreateInput.js';
import {
  APPROVED_ALIAS_FINGERPRINTS,
  APPROVED_REPLACEMENT_SALES_PERSON,
} from './repair-legacy-sales-person-aliases.constants.js';
import {
  assertExactTargetIds,
  assertLockedRowShape,
  fingerprintAlias,
  guard,
} from './repair-legacy-sales-person-aliases.guards.js';

export function resolveCurrentSourceMapping(
  currentValue,
  fingerprint = fingerprintAlias(currentValue),
) {
  if (fingerprint === APPROVED_ALIAS_FINGERPRINTS[0]) {
    const normalized = normalizeOrderMutationInput({
      sales_person: currentValue,
    }).sales_person;
    return normalized !== currentValue
      && normalized === APPROVED_REPLACEMENT_SALES_PERSON
      && ALLOWED_SALES_PERSONS.includes(normalized)
      ? normalized
      : null;
  }

  return null;
}

export function buildRepairPlan(
  rows,
  { resolveSourceMapping = resolveCurrentSourceMapping } = {},
) {
  assertExactTargetIds(rows);

  return [...rows]
    .sort((left, right) => left.id - right.id)
    .map((row) => {
      assertLockedRowShape(row);
      guard(
        !ALLOWED_SALES_PERSONS.includes(row.sales_person),
        'ALREADY_CANONICAL',
        row.id,
      );

      const fingerprint = fingerprintAlias(row.sales_person);
      guard(
        APPROVED_ALIAS_FINGERPRINTS.includes(fingerprint),
        'ALIAS_FINGERPRINT_MISMATCH',
        row.id,
      );

      const replacementSalesPerson = resolveSourceMapping(
        row.sales_person,
        fingerprint,
      );
      guard(
        ALLOWED_SALES_PERSONS.includes(replacementSalesPerson)
          && replacementSalesPerson === APPROVED_REPLACEMENT_SALES_PERSON
          && replacementSalesPerson !== row.sales_person,
        'SOURCE_MAPPING_MISMATCH',
        row.id,
      );

      return Object.freeze({
        id: row.id,
        fingerprint,
        originalSalesPerson: row.sales_person,
        replacementSalesPerson,
        preimage: Object.freeze({
          order_date: row.order_date,
          due_date: row.due_date,
          work_order_image_url: row.work_order_image_url,
        }),
      });
    });
}

export function buildSanitizedSummary(mode, plan) {
  return {
    ok: true,
    mode,
    candidateCount: plan.length,
    rows: plan.map(({ id, fingerprint }) => ({ id, fingerprint })),
    predicates: {
      exactIds: true,
      postgresTypes: true,
      imageBacked: true,
      canonicalDates: true,
      approvedFingerprints: true,
      currentSourceMapping: true,
    },
  };
}
