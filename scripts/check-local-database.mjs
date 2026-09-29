import pg from "pg";

const url = process.env.HPOS_DATABASE_URL;
const expected = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (url !== expected) {
  console.error("Local PostgreSQL verification refused a non-canonical test database URL.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 2_000 });
try {
  const result = await pool.query(`select current_database() as database_name, to_regclass('hpos.organizations') is not null as schema_ready`);
  if (result.rows[0]?.database_name !== "postgres" || result.rows[0]?.schema_ready !== true) {
    console.error("Local PostgreSQL does not have the HP-OS operational schema.");
    console.error("Confirm `supabase/config.toml` and the version-controlled migration before continuing.");
    process.exitCode = 1;
  } else {
    console.log("Verified the local PostgreSQL database and HP-OS operational schema.");
  }
} catch {
  console.error("Local PostgreSQL is unavailable or its HP-OS migration is not applied.");
  console.error("Confirm the Supabase local stack and its version-controlled migration before continuing.");
  process.exitCode = 1;
} finally {
  await pool.end();
}
