import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn("pnpm", ["exec", "supabase", "stop"], {
  cwd: root,
  env: { ...process.env, SUPABASE_HOME: path.join(root, ".local-supabase-home"), SUPABASE_TELEMETRY_DISABLED: "1" },
  stdio: "inherit",
});
child.once("error", (error) => {
  console.error(error instanceof Error ? error.message : "Supabase local services could not be stopped.");
  process.exitCode = 1;
});
child.once("exit", (code) => { process.exitCode = code ?? 1; });
