#!/usr/bin/env node
/**
 * PatchWarden Control Center — local HTTP dashboard service.
 *
 * Binds to 127.0.0.1 only. Serves the static UI from `ui/` and exposes a set
 * of fault-tolerant JSON APIs for inspecting runtime state and driving
 * `scripts/control/manage-patchwarden.ps1` for process lifecycle.
 *
 * Run: node dist/controlCenter.js
 *   or: npm run start:control
 *
 * Port override: PATCHWARDEN_CONTROL_PORT=<n>  or  --port <n>
 *
 * This file is a thin entry shell. All routing, middleware, and server
 * lifecycle live in `src/control/` (server.ts, routes/*.ts, middleware/*.ts,
 * shared.ts, runtime.ts). Importing `startServer` triggers the fault-tolerant
 * config bootstrap, control-token generation, and port resolution as side
 * effects of loading `shared.ts`.
 */

import { startServer } from "./control/server.js";

startServer();
