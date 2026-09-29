import { Pool } from "pg";

const DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const globalPool = globalThis as typeof globalThis & { hposDatabasePool?: Pool };

export function getBusinessPool(): Pool {
  globalPool.hposDatabasePool ??= new Pool({
    connectionString: process.env.HPOS_DATABASE_URL ?? DEFAULT_DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  return globalPool.hposDatabasePool;
}
