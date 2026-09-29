import { Pool } from "pg";
import { DEFAULT_DATABASE_URL, isLocalDatabaseUrl } from "./environment";
import type { HistoryRecord } from "./types";

let pool: Pool | undefined;

function getPool(): Pool {
  const connectionString = process.env.HPOS_DATABASE_URL ?? DEFAULT_DATABASE_URL;
  if (!isLocalDatabaseUrl(connectionString)) throw new Error("The workbench database target is not the approved local test database.");
  pool ??= new Pool({ connectionString, max: 4, connectionTimeoutMillis: 2_000, idleTimeoutMillis: 10_000 });
  return pool;
}

export interface LocalDatabaseState {
  ready: boolean;
  database: "postgres" | null;
  target: "127.0.0.1:54322";
  marker: "local-test" | null;
  message: string;
}

export async function inspectLocalDatabase(): Promise<LocalDatabaseState> {
  try {
    const result = await getPool().query<{ database_name: string; marker: string | null }>(`
      select current_database() as database_name,
        (select environment from workbench.local_environment where singleton = true) as marker
    `);
    const row = result.rows[0];
    const ready = row?.database_name === "postgres" && row.marker === "local-test";
    return {
      ready,
      database: row?.database_name === "postgres" ? "postgres" : null,
      target: "127.0.0.1:54322",
      marker: row?.marker === "local-test" ? "local-test" : null,
      message: ready ? "Dedicated local test PostgreSQL is ready." : "The local database marker is missing; verify the HP-OS migrations.",
    };
  } catch {
    return { ready: false, database: null, target: "127.0.0.1:54322", marker: null, message: "Local PostgreSQL is unavailable or its HP-OS migration is not applied." };
  }
}

export async function insertHistory(record: Omit<HistoryRecord, "id" | "recorded_at">): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `insert into workbench.call_history (
      source, attempt, method, route, request_snapshot, expectation_snapshot,
      result_state, outcome_state, status_code, response_snapshot, error_code,
      duration_ms, capture_state, environment, dataset_label, revision
    ) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10::jsonb,
      $11, $12, $13, $14, $15, $16)
    returning id`,
    [record.source, record.attempt, record.method, record.route, JSON.stringify(record.request_snapshot), record.expectation_snapshot === null ? null : JSON.stringify(record.expectation_snapshot), record.result_state, record.outcome_state, record.status_code, record.response_snapshot === null ? null : JSON.stringify(record.response_snapshot), record.error_code, record.duration_ms, record.capture_state, record.environment, record.dataset_label, record.revision],
  );
  return result.rows[0].id;
}

export async function readHistory(limit = 100): Promise<{ records: HistoryRecord[]; total: number }> {
  const db = getPool();
  const [records, count] = await Promise.all([
    db.query<HistoryRecord>(`select id, recorded_at, source, attempt, method, route, request_snapshot, expectation_snapshot, result_state, outcome_state, status_code, response_snapshot, error_code, duration_ms, capture_state, environment, dataset_label, revision from workbench.call_history order by recorded_at desc, id desc limit $1`, [limit]),
    db.query<{ count: string }>(`select count(*)::text as count from workbench.call_history`),
  ]);
  return { records: records.rows, total: Number(count.rows[0]?.count ?? 0) };
}

export async function readAllHistory(): Promise<HistoryRecord[]> {
  const result = await getPool().query<HistoryRecord>(`select id, recorded_at, source, attempt, method, route, request_snapshot, expectation_snapshot, result_state, outcome_state, status_code, response_snapshot, error_code, duration_ms, capture_state, environment, dataset_label, revision from workbench.call_history order by recorded_at asc, id asc`);
  return result.rows;
}

export async function clearHistory(): Promise<number> {
  const result = await getPool().query(`delete from workbench.call_history`);
  return result.rowCount ?? 0;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = undefined;
    await current.end();
  }
}
