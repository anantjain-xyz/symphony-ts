---
name: land
description: Squash-merge the issue's PR once it's approved and green. Use only when the issue is in the `Merging` state — Symphony's status router gates entry.
---

# Land

## Preconditions

- Issue state is `Merging`.
- `gh auth status` succeeds.
- A PR is attached to the issue and is `OPEN` (not `CLOSED`/`MERGED`).

If the PR is already `MERGED` when entering this skill, skip the merge: record the merge SHA in the workpad and move the issue to `Done`.

## Steps

1. Inspect the PR:
   ```sh
   gh pr view --json number,state,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
   ```
   Required: `state=OPEN`, `reviewDecision=APPROVED` (or no required reviewers), required checks green.
2. Sync first — run the `pull` skill to merge `origin/main`. Conflicts must be resolved in code; never leave a `DIRTY`/`CONFLICTING` PR. Re-run validation after the merge.
3. Push the merge result with the `push` skill.
4. Squash-merge with auto-merge so the merge fires only after checks pass:
   ```sh
   gh pr merge --squash --auto
   ```
   If auto-merge is disabled on the repo, fall back to a direct merge once checks are green:
   ```sh
   gh pr merge --squash
   ```
5. Wait for the merge to complete, with a hard cap and terminal-state guard so the loop can't hang:
   ```sh
   for _ in $(seq 1 60); do
     read -r state checks <<<"$(gh pr view --json state,mergeStateStatus -q '.state + " " + .mergeStateStatus')"
     case "$state" in
       MERGED) break ;;
       CLOSED) echo "PR closed without merge" >&2; exit 1 ;;
     esac
     case "$checks" in
       BLOCKED|DIRTY) echo "Merge blocked: $checks" >&2; exit 1 ;;
     esac
     sleep 30
   done
   [ "$(gh pr view --json state -q .state)" = "MERGED" ] || { echo "Timed out waiting for merge" >&2; exit 1; }
   ```
   Tune the iteration count (60 × 30s = 30 min) if the repo's checks are slower. Any exit-1 path falls into the failure-mode handler below: record the cause and move the issue to `Rework`.
6. Capture the merge commit:
   ```sh
   gh pr view --json mergeCommit -q .mergeCommit.oid
   ```
7. The remote head branch usually auto-deletes. If not, leave it — don't delete in scripts.
8. Record the merge SHA in the workpad's `### Notes` and move the issue to `Done`.

## Failure modes → Rework

If any of the following hit, record the cause in the workpad and move the issue to `Rework` with a brief blocker note:

- Required checks went red on the merge candidate and you can't fix locally.
- Auto-merge is disabled and direct merge keeps failing.
- The merge result reintroduces a conflict you can't resolve.
- The wait loop times out, the PR transitions to `CLOSED` without `MERGED`, or `mergeStateStatus` flips to `BLOCKED`/`DIRTY` while waiting.

Do not force-push, reset, or close-and-reopen the PR to escape the failure.
