# OpenAI Tunnel Examples

This directory contains privacy-safe examples for connecting Safe-Bifrost to
ChatGPT through an OpenAI Secure MCP Tunnel.

Do not commit real API keys, tunnel IDs, ChatGPT workspace IDs, account names,
or local private paths.

## Files

- `tunnel-client.example.yaml` - profile snippets for stdio and HTTP mode
- `chatgpt-test-prompt.md` - prompt to verify the connector from ChatGPT

## Recommended Windows Flow

1. Configure `safe-bifrost.config.json`.
2. Run `npm.cmd run build`.
3. Use `scripts/safe-bifrost-mcp-stdio.cmd` as the tunnel MCP command.
4. Start `npm.cmd run watch` in a separate terminal.
5. Start `tunnel-client run` or use `Start-SafeBifrost-Tunnel.cmd`.
6. Create a ChatGPT Connector using the tunnel channel.
7. After a tunnel/schema refresh, reconnect the Connector and validate from a
   new ChatGPT conversation; an already-open conversation may retain its older
   tool catalog.

The Windows launcher prompts for the runtime API key once and stores only a
Windows DPAPI-encrypted value under `%APPDATA%\safe-bifrost`. Use
`Reset-SafeBifrost-Tunnel-Key.cmd` to remove the saved credential.

Before the launcher starts the tunnel it performs a real MCP stdio handshake
and requires the exact `chatgpt_core` manifest. Run
`Check-SafeBifrost-Health.cmd` to see the version, profile, tool names, schema
hash, process sources, and any mixed-version warnings. The check is read-only.
The v0.4.0 core manifest contains 16 tools. A different count or schema hash
requires a Connector refresh and validation from a new ChatGPT conversation.

## Architecture

```text
ChatGPT Web
-> ChatGPT Connector
-> OpenAI Secure MCP Tunnel
-> Safe-Bifrost MCP Server
-> watcher
-> local agent
-> .safe-bifrost/tasks/<task_id>/
-> ChatGPT reads result, diff, and test log
```
