---
schema_version: 1
id: D-0002
title: External progress is independent of Git
date: "2026-10-04"
status: accepted
area: product
implementation: implemented
supersedes: []
superseded_by: null
visibility: repository
---

## Context and choice
Requested by the owner: hypothesis checks should lead to external evidence and explicit decisions. The agent implements a separate checks area using the existing local API and SQLite. Reusing task status would lose the question, criteria and completion basis. No experiment platform or AI layer is needed.

## Semantics and consequences
Dates are ISO calendar dates, shown exactly alongside relative days. Elapsed days are calendar days from startedAt through completion (paused time is not subtracted). An external action advances external movement; evidence has its own latest date and does not silently reset the action clock. With no actions, the clock starts at startedAt. Only active checks generate stagnation signals. Pausing suppresses reminders, resuming retains the original history. Git never resets that clock. Any commit within seven days can support the internal-work signal; no inaccurate count inferred from a truncated log.

Multiple active checks are allowed. Creating another active check for the same idea requires explicit confirmation. Completion requires a result, confirmation/rejection summary, outcome and basis. Completed checks stay in the archive; a next check is created only explicitly.

## Implementation and review
Owners: `shared/checks.ts`, `server/checks/`, `src/features/checks/`. Verified by `tests/checks.test.ts` and `tests/e2e/stage2.spec.ts`: 3/7/14 boundaries, future dates, edits/deletions, pause, resume, and completion. Production smoke confirms restart persistence. Review by the project owner if paused-duration accounting or different meanings of external movement become necessary.
