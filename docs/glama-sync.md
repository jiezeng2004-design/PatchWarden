# Glama Sync

This repository is published to the existing Glama entry `dhtp68hzou` as a
local-only MCP server. Keep the entry aligned with the repository runtime.

## Runtime settings

- Hosting: `local-only`
- Base image: Node 24
- Transport: stdio
- Required environment variables: none
- Start command: `node dist/index.js`

Build the server with the following commands:

```text
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

The Glama runtime must start only the MCP stdio entry. Do not start the
Control Center, Watcher, tunnel supervisor, or the `start:control` script in
the Glama container. The Control Center and Watcher are local desktop
components and are outside the published stdio contract.

## Metadata drift checklist

Before synchronizing, remove any legacy required configuration-file setting or
placeholder from the Glama entry. The published entry must have no required
environment variables and must not depend on a file mounted at a fixed
container path.

After synchronization, verify that:

1. `initialize` succeeds over stdio.
2. `tools/list` returns the non-empty PatchWarden catalog.
3. `health_check` succeeds.
4. `hosting:local-only` remains unchanged.

If the entry is edited in the Glama UI, repeat this checklist after every
metadata refresh so an old runtime definition cannot replace the Node stdio
entry again.
