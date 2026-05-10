# Error handling

This document codifies how the worker and dashboard handle thrown errors and
rejected promises. CI enforces the syntactic part of the rule via Biome's
`suspicious/noEmptyBlockStatements`; the semantic part (what to do *inside* the
block) is on the reviewer.

## The rule

1. **Never write `} catch {}` or `=> {}` without a comment.** A bare empty
   block reads like an oversight. A one-line comment is the cheapest way to
   prove the silencing was intentional and to record *why* it is safe.

2. **Default to logging.** Catch the error as `err`, format it with
   `formatError(err)` from `@symphony/shared`, and log at `warn` (transient or
   self-healing) or `debug` (truly expected, e.g. `ENOENT` from a probe).
   `error` is reserved for failures that the caller will not recover from.

3. **Best-effort DB cleanup uses the `bestEffort` helper.** Any
   `repo.<write>(...)` whose failure should not abort the surrounding flow
   (e.g. `repo.deleteLiveSession(...)` after a run already finished) goes
   through `apps/worker/src/util/best-effort.ts`:

   ```ts
   await bestEffort(repo.deleteLiveSession(run.id), log, 'deleteLiveSession', {
     runId: run.id,
   });
   ```

   Do **not** introduce parallel `.catch(() => {})` chains for DB writes. One
   helper, one log shape, one place to change the policy.

4. **Filesystem existence probes use `pathExists` / `readyExists`** from
   `apps/worker/src/workspace/manager.ts`, not bare `try { stat(p) } catch {}`.
   The probe form hides the intent (`stat` is being used to check existence),
   and `noEmptyBlockStatements` flags it anyway.

5. **Stray promises that exist only to mute `unhandledRejection`** (typically
   on a side-promise we already observe through another path) keep
   `.catch(() => { /* … */ })` form, but the inline comment is mandatory and
   must say *why* the rejection is observed elsewhere.

## When a bare `catch` is acceptable

Almost never. The exceptions are documented inline at each site:

- A `.catch(() => { /* … */ })` attached to a side-promise whose rejection is
  already routed through a different path (e.g. `AgentRunner.completion` is
  awaited in `run()`; the silent handler exists only so an early-exit
  rejection doesn't crash the worker via `unhandledRejection`).
- An SSE / pg-LISTEN cleanup path that races client abort and routinely
  throws `connection destroyed` / `already closed` on disconnect — see
  `apps/dashboard/src/lib/sse.ts`. The block-comment above the cleanup spells
  out the race; per-line inline comments would be noise.

## Adding a new catch site

1. Decide: is the failure recoverable, expected, or fatal?
   - Recoverable → `log.warn({ err: formatError(err), …context }, '…')` and
     continue.
   - Expected (e.g. `ENOENT` from a probe) → use a named existence helper, or
     add `log.debug` with an inline comment explaining the expectation.
   - Fatal → re-throw or convert to a structured error the caller can handle.
2. If the failure is from a DB cleanup write, use `bestEffort`.
3. If you really want to silence, leave a comment inside the block. Biome
   will fail CI if you forget.
