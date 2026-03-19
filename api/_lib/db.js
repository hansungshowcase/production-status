import { neon } from '@neondatabase/serverless';

function convertPlaceholders(sql) {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

export function getDb() {
  const sql = neon(process.env.POSTGRES_URL);

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
        async commit() {},
        async rollback() {},
      };
    },
  };
}
