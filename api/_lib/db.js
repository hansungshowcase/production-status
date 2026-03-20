import { neon } from '@neondatabase/serverless';

function convertPlaceholders(sql) {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

// Module-level connection cache (reused across requests in the same serverless instance)
let cachedSql = null;

export function getDb() {
  if (!cachedSql) {
    cachedSql = neon(process.env.POSTGRES_URL);
  }
  const sql = cachedSql;

  return {
    async execute({ sql: query, args = [] }) {
      const pgSql = convertPlaceholders(query);
      const rows = await sql.query(pgSql, args);
      return {
        rows,
        rowsAffected: rows.length,
        lastInsertRowid: rows?.[0]?.id ?? null,
      };
    },
    async transaction(mode) {
      await sql('BEGIN');
      let done = false;
      return {
        async execute({ sql: query, args = [] }) {
          const pgSql = convertPlaceholders(query);
          const rows = await sql(pgSql, args);
          return {
            rows,
            rowsAffected: rows.length,
            lastInsertRowid: rows?.[0]?.id ?? null,
          };
        },
        async commit() { if (!done) { await sql('COMMIT'); done = true; } },
        async rollback() { if (!done) { await sql('ROLLBACK'); done = true; } },
      };
    },
  };
}
