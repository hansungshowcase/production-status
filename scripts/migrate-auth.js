import { neon } from '@neondatabase/serverless';
import { pathToFileURL } from 'node:url';
import {
  APP_PRIVATE_CONFIG_SCHEMA_SQL,
  AUTH_CREDENTIALS_SCHEMA_SQL,
} from '../api/_lib/authCredentialSchema.js';

export async function runAuthMigration(sql) {
  await sql.query(AUTH_CREDENTIALS_SCHEMA_SQL);
  await sql.query(APP_PRIVATE_CONFIG_SCHEMA_SQL);
}

async function migrateAuth() {
  if (!process.env.POSTGRES_URL) throw new Error('POSTGRES_URL is not configured');
  const sql = neon(process.env.POSTGRES_URL);
  await runAuthMigration(sql);
  console.log('Authentication schema migration complete.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateAuth().catch((error) => {
    console.error('Authentication schema migration failed.');
    process.exitCode = 1;
  });
}
