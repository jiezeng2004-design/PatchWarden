# PatchWarden Governance

PatchWarden is currently maintained by `jiezeng2004-design`.

## Maintainer Responsibilities

The maintainer is responsible for:

- preserving workspace confinement, command allowlists, sensitive-path blocking,
  explicit agent registration, and auditable task artifacts
- reviewing changes before release
- keeping README files, examples, tool manifests, package metadata, and release
  notes aligned
- triaging issues and security reports
- deciding when a change is ready for npm/GitHub publication

## Decision Making

PatchWarden is early-stage and uses maintainer-led decisions. Changes that
affect the safety boundary should be conservative and evidence-backed. If a
change makes the system more convenient but weakens auditability, command
control, path control, or secret protection, it should not be accepted without a
clear alternative mitigation.

## Release Authority

Publishing is manual. A local build or package check is not enough to declare a
release complete. Release completion requires separate verification of:

- merged PR or reviewed release branch
- GitHub CI gate
- Git tag
- GitHub Release
- npm package version
- `dist-tags.latest`

## Adding Maintainers

Additional maintainers can be added after sustained, high-quality
contributions, especially in tests, documentation, security review, and
cross-platform setup. New maintainers must agree to preserve the safety model
and avoid storing credentials or private user data in the repository.
