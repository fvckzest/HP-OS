import pg from "pg";

const url = process.env.HPOS_DATABASE_URL;
const expected = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (url !== expected) {
  console.error("Local PostgreSQL verification refused a non-canonical test database URL.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 2_000 });
try {
  const result = await pool.query(`select current_database() as database_name, (select environment from workbench.local_environment where singleton = true) as marker`);
  if (result.rows[0]?.database_name !== "postgres" || result.rows[0]?.marker !== "local-test") {
    console.error("Local PostgreSQL did not pass the HP-OS local test marker check.");
    console.error("Confirm `supabase/config.toml` and the version-controlled migration before continuing.");
    process.exitCode = 1;
  } else {
    console.log("Verified direct PostgreSQL access to the dedicated local test database.");
  }
} catch {
  console.error("Local PostgreSQL is unavailable or its HP-OS migration is not applied.");
  console.error("Confirm the Supabase local stack and its version-controlled migration before continuing.");
  process.exitCode = 1;
} finally {
  await pool.end();
}
