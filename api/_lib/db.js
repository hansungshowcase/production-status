import { createPool } from '@vercel/postgres';

let pool = null;

function getPool() {
  if (!pool) {
    pool = createPool({
      connectionString: process.env.POSTGRES_URL,
    });
  }
  return pool;
}

// Convert ? placeholders to $1, $2, ... for PostgreSQL
function convertPlaceholders(sql) {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

export function getDb() {
  const p = getPool();
  return {
    async execute({ sql, args = [] }) {
      const pgSql = convertPlaceholders(sql);
      const result = await p.query(pgSql, args);
      return {
        rows: result.rows,
        rowsAffected: result.rowCount,
        lastInsertRowid: result.rows?.[0]?.id ?? null,
      };
    },
    async transaction(mode) {
      const client = await p.connect();
      await client.query('BEGIN');
      return {
        async execute({ sql, args = [] }) {
          const pgSql = convertPlaceholders(sql);
          const result = await client.query(pgSql, args);
          return {
            rows: result.rows,
            rowsAffected: result.rowCount,
            lastInsertRowid: result.rows?.[0]?.id ?? null,
          };
        },
        async commit() {
          await client.query('COMMIT');
          client.release();
        },
        async rollback() {
          try { await client.query('ROLLBACK'); } catch {}
          client.release();
        },
      };
    },
  };
}
