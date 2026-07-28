# OpenHands Governance Layer Discussion

Status checked 2026-07-28: archived design draft. The previously recorded
OpenHands issue and comment no longer resolve through the GitHub API, so this
document must not be cited as a live or accepted upstream discussion. Do not
open a large implementation PR before maintainers identify the intended
enforcement point in a current public channel.

Target: [OpenHands repository](https://github.com/OpenHands/OpenHands)

The now-unresolvable thread had no recorded maintainer conclusion during the
2026-07-25 review. Re-check the current issue tracker and contribution guidance
before reusing this draft.

## Position

Sandboxing and governance are complementary:

- a sandbox limits what the runtime can reach
- a governance layer decides whether a reachable action should execute

A governance boundary should evaluate actions before execution, return a
structured denial that the agent can handle, and persist bounded audit evidence.
An external gateway is one deployment option when a native hook is unavailable
or policy must be shared across multiple agent frameworks.

Useful capabilities include:

- file read/write policy
- exact command allowlists and deterministic deny rules
- risk scoring and stable reason codes
- local human approval tickets
- cost and iteration budget hooks
- bounded, redacted audit evidence
- secret and PII scanning before commit or final output

## Copy-Paste Issue Comment

> I think it is useful to keep two boundaries distinct here: a sandbox answers
> **what the runtime can reach**, while a governance layer answers **whether a
> reachable action should execute**. They are complementary rather than
> substitutes. A container can limit host impact while still allowing an agent
> to delete its mounted repository, send sensitive workspace data to an allowed
> endpoint, or spend an unbounded session budget.
>
> A small pre-execution governance contract could normalize an action and
> return a deterministic `ALLOW`, `REQUIRE_APPROVAL`, or `DENY` decision with
> stable reason codes. The first useful policy surfaces would be file access,
> exact command allowlists/denylists, risk scoring, a local approval ticket,
> cost/iteration budget hooks, and a secret/PII check before commit or final
> output. Every outcome, including a blocked action, should produce bounded and
> redacted audit evidence.
>
> This could support both native and external implementations. A native policy
> implementation could plug directly into the contract; an external governance
> service could apply organization-wide policy across OpenHands and other agent
> runtimes. PatchWarden is one example of the external pattern, but the hook
> should remain vendor-neutral.
>
> The key requirement is enforcement immediately before the runtime performs
> the action. An EventStream observer that only sees the action after execution
> would be useful for audit but not prevention. Is there a current pre-runtime
> dispatch point where an async policy decision can return a denied observation
> without crashing the agent? Maintainer guidance on that extension point would
> make it possible to prototype a narrow interface before proposing a larger
> implementation.

This draft intentionally asks for an extension point rather than volunteering
a large PR. Find and re-check a current public thread before any implementation
proposal.
