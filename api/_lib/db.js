import { neon } from '@neondatabase/serverless';

function convertPlaceholders(sql) {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

// Module-level connection cache (reused across requests in the same serverless instance)
let cachedSql = null;

export function getDb() {
  if (!process.env.POSTGRES_URL) {
    const err = new Error('POSTGRES_URL is not configured');
    err.status = 500;
    throw err;
  }

  if (!cachedSql) {
    cachedSql = neon(process.env.POSTGRES_URL);
  }
  const sql = cachedSql;

  const executeQuery = async ({ sql: query, args = [] }) => {
    const pgSql = convertPlaceholders(query);
    let rows;
    try {
      rows = await sql.query(pgSql, args);
    } catch (err) {
      const message = String(err?.message || '');
      if (message.includes('exceeded the data transfer quota')) {
        err.status = 503;
        err.publicMessage = '데이터베이스 전송량 한도가 초과되었습니다. 관리자 조치 후 다시 이용할 수 있습니다.';
      }
      throw err;
    }
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
