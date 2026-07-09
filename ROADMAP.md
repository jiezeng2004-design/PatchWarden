# PatchWarden Roadmap

This roadmap focuses on application-readiness, public evidence, and safer
maintainer workflows. It is not a promise of dates.

## Near Term

- Align source version, README version text, changelog, GitHub Release, and npm
  for the next release.
- Add a short public demo video or GIF that shows ChatGPT/Codex to PatchWarden
  to local agent execution to evidence review.
- Collect real tester feedback through GitHub issues or discussions.
- Add contributor-friendly issues for macOS setup docs, Codex CLI examples, and
  a minimal demo repository.
- Keep `docs/open-source-application.md`, `docs/threat-model.md`, and
  `docs/release-evidence.md` current before external submissions.

## Safety And Verification

- Continue expanding smoke coverage for changed behavior.
- Keep safe summaries as the default UI and MCP review surface.
- Improve release evidence checks that compare local source state with GitHub
  Release and npm registry truth.
- Improve diagnostic copy/export flows while preserving redaction.

## Compatibility

- Document tested flows for ChatGPT Connector, Codex CLI, OpenCode, and common
  Windows PowerShell setups.
- Add focused examples for profile-specific MCP usage.
- Improve troubleshooting for proxy, npm cache, GitHub CLI, and local agent
  path issues.

## Community

- Keep issue templates practical and privacy-aware.
- Label small documentation and example tasks as `good first issue` when they
  are safe for new contributors.
- Track real feedback in `docs/user-feedback.md`.
