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

  const executeQuery = async ({ sql: query, args = [] }) => {
    const pgSql = convertPlaceholders(query);
    const rows = await sql.query(pgSql, args);
    return {
      rows,
      rowsAffected: rows.length,
      lastInsertRowid: rows?.[0]?.id ?? null,
    };
  };

  return {
    execute: executeQuery,
    // Neon HTTP driver does not support real transactions (each call is independent).
    // transaction() returns an object with the same execute() for compatibility,
    // commit/rollback are no-ops. Callers should handle errors themselves.
    async transaction(mode) {
      return {
        execute: executeQuery,
        async commit() {},
        async rollback() {},
      };
    },
  };
}
