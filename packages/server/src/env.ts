import { config as loadDotenv } from "dotenv";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Side-effecting bootstrap: load the repo-root `.env` into process.env BEFORE any
// Effect `Config.*` read runs. Import this first in every tsx entrypoint
// (`import "./env.js";`) so the pipeline commands work on a bare shell — no more
// `set -a; source .env; set +a`. There is no runtime framework reading .env for us;
// Config.* reads straight from process.env.
//
// Walks UP from this module's location (not process.cwd()) because pnpm runs
// workspace scripts with cwd = packages/server, while `.env` lives at the repo root.
// dotenv does NOT override variables already present in the real environment, so
// CI / production (which export real env vars) are unaffected — the file is a
// dev-convenience fallback only.
const start = path.dirname(fileURLToPath(import.meta.url));

let dir = start;
for (;;) {
  const candidate = path.join(dir, ".env");
  if (fs.existsSync(candidate)) {
    loadDotenv({ path: candidate });
    break;
  }
  const parent = path.dirname(dir);
  if (parent === dir) break; // hit filesystem root, no .env — rely on real env
  dir = parent;
}
