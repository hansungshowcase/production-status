export const EXPECTED_VERCEL_PROJECT = Object.freeze({
  id: 'prj_7URD4gLkA3qkeCne2xTwUDm9SMx1',
  name: 'production-status',
});

export const EXPECTED_CONNECTION_FINGERPRINT =
  'd94c168442a34bb238ee7e60ca5b22cecd26254818bcd314e6983470a9d73175';

export const REPAIR_ORDER_IDS = Object.freeze([203, 204, 205, 206, 207, 208]);

export const APPROVED_ALIAS_FINGERPRINTS = Object.freeze([
  'c257f49e680b',
  'fe0c69469f49',
]);

export const POSTGRES_TEXT_FIELDS = Object.freeze([
  'order_date',
  'due_date',
  'sales_person',
  'work_order_image_url',
]);

export const LOCKED_PREFLIGHT_SQL = `
  SELECT
    id,
    order_date,
    due_date,
    sales_person,
    work_order_image_url,
    pg_typeof(id)::text AS id_type,
    pg_typeof(order_date)::text AS order_date_type,
    pg_typeof(due_date)::text AS due_date_type,
    pg_typeof(sales_person)::text AS sales_person_type,
    pg_typeof(work_order_image_url)::text AS work_order_image_url_type
  FROM orders
  WHERE id = ANY($1::integer[])
  ORDER BY id
  FOR UPDATE
`;

export const POST_COMMIT_VERIFY_SQL = `
  SELECT
    id,
    order_date,
    due_date,
    sales_person,
    work_order_image_url,
    pg_typeof(id)::text AS id_type,
    pg_typeof(order_date)::text AS order_date_type,
    pg_typeof(due_date)::text AS due_date_type,
    pg_typeof(sales_person)::text AS sales_person_type,
    pg_typeof(work_order_image_url)::text AS work_order_image_url_type
  FROM orders
  WHERE id = ANY($1::integer[])
  ORDER BY id
`;

export const COMPARE_AND_SET_SQL = `UPDATE orders
  SET sales_person = $1
  WHERE id = $2
    AND sales_person IS NOT DISTINCT FROM $3
  RETURNING id`;

export const SERVER_IDENTITY_SQL = `
  SELECT
    current_database() AS database_name,
    current_user AS user_name,
    current_setting('neon.project_id', true) AS neon_project_id
`;
