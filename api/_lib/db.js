import { neon } from '@neondatabase/serverless';

function convertPlaceholders(sql) {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

export function normalizeDatabaseError(err) {
  const message = String(err?.message || '');
  if (
    message.includes('exceeded the compute time quota')
    || message.includes('exceeded the data transfer quota')
  ) {
    err.status = 503;
    err.publicMessage = '데이터베이스 사용 한도가 초과되어 잠시 처리할 수 없습니다. 관리자에게 Neon production-status 리소스 확인을 요청해주세요.';
  }
  return err;
}

// Module-level connection cache reused across requests in the same serverless instance.
let cachedSql = null;

export function createDbAdapter(sql) {
  const executeQuery = async ({ sql: query, args = [] }) => {
    const pgSql = convertPlaceholders(query);
    let rows;
    try {
      rows = await sql.query(pgSql, args);
    } catch (err) {
      throw normalizeDatabaseError(err);
    }
    return {
      rows,
      rowsAffected: rows.length,
      lastInsertRowid: rows?.[0]?.id ?? null,
    };
  };

  return {
    execute: executeQuery,
    async atomicBatch(queries, options = {}) {
      const maxAttempts = Math.max(1, Math.min(3, Number(options.maxAttempts) || 3));
      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const resultSets = await sql.transaction(
            (tx) => queries.map(({ sql: query, args = [] }) => (
              tx.query(convertPlaceholders(query), args)
            )),
            { isolationLevel: 'Serializable' },
          );
          return resultSets.map((rows) => ({
            rows,
            rowsAffected: rows.length,
            lastInsertRowid: rows?.[0]?.id ?? null,
          }));
        } catch (error) {
          lastError = error;
          if (error?.code !== '40001' || attempt === maxAttempts) break;
        }
      }

      if (lastError?.code === '40001') {
        lastError.status = 409;
        lastError.publicMessage = '다른 작업이 동시에 처리되었습니다. 새로고침 후 다시 시도해 주세요.';
        throw lastError;
      }
      throw normalizeDatabaseError(lastError);
    },
    // Neon HTTP driver does not support real transactions; keep this compatibility wrapper.
    async transaction() {
      return {
        execute: executeQuery,
        async commit() {},
        async rollback() {},
      };
    },
  };
}

export function getDb() {
  if (!process.env.POSTGRES_URL) {
    const err = new Error('POSTGRES_URL is not configured');
    err.status = 500;
    throw err;
  }

  if (!cachedSql) {
    cachedSql = neon(process.env.POSTGRES_URL);
  }
  return createDbAdapter(cachedSql);
}
