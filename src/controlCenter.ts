#!/usr/bin/env node
/**
 * PatchWarden Control Center — entry point.
 *
 * This file imports and initializes the server from src/controlCenter/server.ts.
 * All logic has been modularized into the src/controlCenter/ directory.
 *
 * Run: node dist/controlCenter.js
 *   or: npm run start:control
 *
 * Port override: PATCHWARDEN_CONTROL_PORT=<n>  or  --port <n>
 */

// The server module handles all initialization and startup
import "./controlCenter/server.js";