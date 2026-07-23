# PatchWarden Open Source Application Brief

This brief is written for programs that evaluate open source maintainer work,
including Codex-style OSS support programs. It is evidence-oriented and avoids
claiming adoption that has not happened yet.

## Project

- Repository: https://github.com/jiezeng2004-design/PatchWarden
- Package: `patchwarden`
- License: MIT
- Primary language: TypeScript
- Runtime: Node.js 18+
- Primary maintainer: `jiezeng2004-design`

PatchWarden is a local-first MCP safety and verification layer for AI coding
agents. It lets ChatGPT, Codex, OpenCode, or another MCP client plan and review
work while a preconfigured local agent performs bounded execution inside a
configured workspace.

## Why This Matters For OSS Maintainers

AI coding workflows are becoming useful for maintainers, but many local bridges
solve convenience by exposing an unrestricted shell or broad filesystem access.
That is a poor default for open source work, where a maintainer may have
credentials, release artifacts, private issue context, unpublished patches, and
multiple repositories on the same machine.

PatchWarden narrows that workflow into an auditable task channel:

- workspace confinement through `workspaceRoot` and repo-scoped task paths
- pre-registered local agents instead of model-supplied shell commands
- exact allowlisted verification commands
- sensitive-path blocking for `.env`, tokens, SSH keys, cookies, and credential
  material
- scope-violation detection for unexpected out-of-repository changes
- structured task artifacts, diffs, verification records, and evidence packs
- release checks that distinguish local verification from GitHub/npm truth

The goal is not to replace human maintainers. The goal is to make AI-assisted
maintenance reviewable enough for routine OSS work: small fixes, test
generation, documentation updates, release preflight checks, and post-task
audit.

## Maintainer Role

I am the primary maintainer of PatchWarden. My work includes architecture,
security boundaries, MCP tool design, TypeScript implementation, CI, release
checklists, documentation, issue/PR templates, and package metadata.

The repository is early-stage, but it is not a throwaway demo. The project has a
documented safety model, bilingual README files, CI across Linux and Windows, a
private security reporting path, release notes, package verification scripts,
and a growing control center for safe summaries, audit views, lineage, and
evidence packs.

## Current Public Evidence

Remote snapshot checked on 2026-07-23:

- GitHub repository: `jiezeng2004-design/PatchWarden`
- Stars: 2
- Forks: 0
- Open issues: 5
- Open pull requests: 1
- GitHub latest release: `v1.6.1`, published on 2026-07-23
- npm latest dist-tag: `patchwarden@1.6.1`

Local workspace facts, kept separate from the public snapshot:

- Local source version in `package.json`: `1.6.1`
- Verified release commit: `2ab2b7405d89b12c4ef10febf56404de59c04053`

The local source, GitHub Release, and npm `latest` are synchronized at `v1.6.1`.
The GitHub Release contains reviewed Core and Windows Desktop assets plus
SHA-256 manifests.

## Existing Project Evidence

Repository-facing evidence already present:

- `README.md` and `README.en.md` explain the MCP bridge model, safety boundary,
  setup, ChatGPT/Codex/OpenCode usage, and local data handling.
- `CHANGELOG.md` records ongoing releases from the 1.0 line through 1.6.1.
- `SECURITY.md` directs vulnerability reports to GitHub private security
  advisories.
- `CONTRIBUTING.md` documents local verification and safety expectations.
- `.github/workflows/ci.yml` runs Node 20 checks on Ubuntu and Windows, full
  regression tests, MCP smoke tests, HTTP MCP smoke tests, redacted doctor,
  clean package verification, npm package-surface verification, and Gitleaks.
- `.github/ISSUE_TEMPLATE/` and `.github/PULL_REQUEST_TEMPLATE.md` guide bug,
  feature, and safety review reports.
- `docs/release-checklist.md` separates local validation, PR review, GitHub
  Release, npm publish, and remote publication verification.
- `docs/chatgpt-usage.md` documents safer ChatGPT connector usage patterns.
- `docs/demo.md` provides a privacy-safe demo flow.
- `docs/assets/patchwarden-chatgpt-demo.svg` provides a repository-safe visual
  demo asset.
- `docs/assets/patchwarden-oss-demo.gif` provides a privacy-safe animated demo
  of the maintainer workflow. It is scripted demo material, not adoption
  evidence.

## Related Project

RelayForge can be mentioned as a related local-first AI coding gateway project,
but PatchWarden should be the primary application repository because its safety
boundary and MCP maintainer workflow are more directly aligned with Codex-style
OSS automation.

## Honest Gaps

PatchWarden should not claim broad adoption yet. The strongest current argument
is ecosystem importance, not stars or download volume.

Known gaps before submission:

- collect 3 to 5 real user reports through GitHub issues or discussions
- record a live screencast if stronger evidence is needed; a privacy-safe
  scripted GIF now exists for the public maintainer workflow
- keep future source, GitHub Release, and npm publication facts synchronized
  through the reviewed release workflow
- add small contributor-friendly roadmap issues such as macOS docs, Codex CLI
  examples, and a minimal demo repository

Do not fabricate feedback, usage numbers, or third-party endorsements.

## Application Statement

PatchWarden addresses a growing safety gap in AI coding workflows: connecting
ChatGPT, Codex, OpenCode, and other MCP clients to local coding agents without
giving the upstream model unrestricted shell access. It provides workspace
confinement, command allowlists, sensitive-path blocking, scope-violation
detection, CI-backed regression tests, release verification, and auditable task
evidence. As the primary maintainer, I maintain the architecture, TypeScript
implementation, documentation, security policy, tests, release workflow, and
review process. The project is early, with low public adoption metrics, but it
directly supports safer OSS maintainer automation for Codex-style agents.

## API Credits Use

API credits would be used for maintainer automation only:

- Codex-assisted pull request review
- security regression analysis
- release evidence review
- documentation consistency checks
- compatibility testing across ChatGPT, Codex, OpenCode, and MCP profiles
- issue triage and small test generation

Credits would not be used to publish releases automatically, bypass human
confirmation, inspect private credentials, or weaken PatchWarden's safety
boundary.

## Submission Checklist

- [ ] Confirm GitHub stars, forks, issues, PRs, and latest release again on the
      day of submission.
- [ ] Confirm `npm.cmd view patchwarden version dist-tags --json`.
- [ ] Confirm README version text matches the intended release story.
- [ ] Link `docs/threat-model.md`.
- [ ] Link `docs/release-evidence.md`.
- [ ] Link `docs/user-feedback.md` only after real feedback exists.
- [x] Prepare a privacy-safe scripted GIF without secrets or private workspace
      names.
- [ ] Optionally record a live screencast for stronger external evidence.
- [ ] Do not click any final application submit button until the maintainer has
      reviewed the form.
