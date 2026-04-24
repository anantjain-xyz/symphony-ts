---
tracker:
  kind: linear
  api_key: ${LINEAR_API_KEY}
  active_states:
    - todo
    - in progress
    - rework
    - merging
  terminal_states:
    - done
    - canceled
    - duplicate
    - closed

polling:
  interval_ms: 30000

workspace:
  root: ${TMPDIR}/symphony-workspaces

hooks:
  after_create: |
    git clone "$REPO_URL" .
    git checkout -B "symphony/${ISSUE_IDENTIFIER}"
  before_run: |
    echo "starting attempt for ${ISSUE_IDENTIFIER}"
  after_run: |
    echo "finished attempt for ${ISSUE_IDENTIFIER}"
  timeout_ms: 60000

agent:
  # Which backend to drive. `codex` spawns `codex-adapter.mjs`; `claude` spawns
  # `claude-adapter.mjs` and supports `pnpm --filter @symphony/worker attach
  # <issue>` to resume the same session from your own terminal.
  backend: claude
  max_concurrent_agents: 4
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    in progress: 2

codex:
  command: node ${SYMPHONY_CODEX_ADAPTER}
  approval_policy: never
  thread_sandbox: workspace-write
  network_access: true
  turn_timeout_ms: 3600000

claude:
  command: node ${SYMPHONY_CLAUDE_ADAPTER}
  # default | acceptEdits | auto | bypassPermissions | dontAsk | plan
  permission_mode: auto
  # Workflow-essential tools the agent needs in every target repo. The target
  # repo's .claude/settings.json can layer in repo-specific extras on top.
  allowed_tools:
    # GitHub CLI (PR create/view/comment/merge, gh api, gh auth status, gh run)
    - Bash(gh *)
    # Git read + the mutating ops the workflow needs (commit/push/branch/etc).
    # Destructive forms (reset --hard, push --force*, clean -f*) intentionally omitted.
    - Bash(git status*)
    - Bash(git log*)
    - Bash(git diff*)
    - Bash(git show*)
    - Bash(git branch*)
    - Bash(git checkout*)
    - Bash(git switch*)
    - Bash(git add*)
    - Bash(git commit*)
    - Bash(git push)
    - Bash(git push origin*)
    - Bash(git pull*)
    - Bash(git fetch*)
    - Bash(git merge*)
    - Bash(git rebase*)
    - Bash(git remote*)
    - Bash(git stash*)
    - Bash(git rev-parse*)
    - Bash(git ls-files*)
    - Bash(git config --get*)
    # Read-only diagnostics the agent commonly probes for.
    - Bash(which *)
    - Bash(node --version)
    - Bash(pnpm --version)
    - Bash(npm --version)
    - Bash(python3 --version)
  disallowed_tools: []
  add_dirs: []
  turn_timeout_ms: 3600000
---

You are working on issue **{{identifier}}: {{title}}**.

## Issue context

- Identifier: {{identifier}}
- Title: {{title}}
- Current state: {{state}}
- Branch: {{branch}}
- Labels: {{#labels.length}}{{#labels}}{{.}} {{/labels}}{{/labels.length}}
{{#description}}

## Description

{{description}}
{{/description}}
{{#blockers.length}}

## Blockers

{{#blockers}}
- {{.}}
{{/blockers}}
{{/blockers.length}}

## Instructions

1. This is an unattended orchestration session. Never ask a human to perform follow-up actions.
2. Only stop early for a true blocker (missing required auth/permissions/secrets). If blocked, record it in the workpad and move the issue according to this workflow.
3. Your final message must report completed actions and blockers only. Do not include "next steps for the user".

Work only in the provided repository copy. Do not touch any other path.

## Prerequisite: Linear MCP or `linear_graphql` tool is available

The agent must be able to talk to Linear, either via a configured Linear MCP server or an injected `linear_graphql` tool. If neither is present, stop and ask the user to configure Linear.

## Default posture

- Start by determining the ticket's current status, then follow the matching flow for that status.
- Start every task by opening the tracking workpad comment and bringing it up to date before doing new implementation work.
- Spend extra effort up front on planning and verification design before implementation.
- Reproduce first: always confirm the current behavior/issue signal before changing code so the fix target is explicit.
- Keep ticket metadata current (state, checklist, acceptance criteria, links).
- Treat a single persistent Linear comment as the source of truth for progress.
- Use that single workpad comment for all progress and handoff notes; do not post separate "done"/summary comments.
- Treat any ticket-authored `Validation`, `Test Plan`, or `Testing` section as non-negotiable acceptance input: mirror it in the workpad and execute it before considering the work complete.
- When meaningful out-of-scope improvements are discovered during execution, file a separate Linear issue instead of expanding scope. The follow-up issue must include a clear title, description, and acceptance criteria, be placed in `Backlog`, be assigned to the same project as the current issue, link the current issue as `related`, and use `blockedBy` when the follow-up depends on the current issue.
- Move status only when the matching quality bar is met.
- Operate autonomously end-to-end unless blocked by missing requirements, secrets, or permissions.
- Use the blocked-access escape hatch only for true external blockers (missing required tools/auth) after exhausting documented fallbacks.

## Status map

- `Backlog` -> out of scope for this workflow; do not modify.
- `Todo` -> queued; immediately transition to `In Progress` before active work.
  - Special case: if a PR is already attached, treat as feedback/rework loop (run full PR feedback sweep, address or explicitly push back, revalidate, return to `In Review`).
- `In Progress` -> implementation actively underway.
- `In Review` -> PR is attached and validated; waiting on human approval.
- `Merging` -> approved by human; follow the land procedure below. Do not call `gh pr merge` directly without verifying checks and approval.
- `Rework` -> reviewer requested changes; planning + implementation required.
- `Done` -> terminal state; no further action required.

## Step 0: Determine current ticket state and route

1. Fetch the issue by explicit ticket ID.
2. Read the current state.
3. Route to the matching flow:
   - `Backlog` -> do not modify issue content/state; stop and wait for human to move it to `Todo`.
   - `Todo` -> immediately move to `In Progress`, then ensure bootstrap workpad comment exists (create if missing), then start execution flow.
     - If a PR is already attached, start by reviewing all open PR comments and deciding required changes vs explicit pushback responses.
   - `In Progress` -> continue execution flow from the current workpad comment.
   - `In Review` -> wait and poll for decision/review updates.
   - `Merging` -> if the branch PR is already `MERGED`, skip the land procedure, record the merge commit SHA in the workpad, and move the issue directly to `Done`. Otherwise follow the land procedure below; do not call `gh pr merge` directly.
   - `Rework` -> run the rework flow.
   - `Done` -> do nothing and shut down.
4. Check whether a PR already exists for the current branch and whether it is closed. This check only applies to pre-merge states (`Todo`, `In Progress`, `Rework`):
   - If a branch PR exists and is `CLOSED` or `MERGED`, treat prior branch work as non-reusable for this run.
   - Create a fresh branch from `origin/main` and restart execution flow as a new attempt.
   - In `Merging` a `MERGED` PR is the expected terminal signal, not a trigger to restart; handle it per the `Merging` routing above.
5. For `Todo` tickets, do startup sequencing in this exact order:
   - transition the issue to `In Progress`
   - find/create `## Symphony Workpad` bootstrap comment
   - only then begin analysis/planning/implementation work.
6. Add a short comment if state and issue content are inconsistent, then proceed with the safest flow.

## Step 1: Start/continue execution (Todo or In Progress)

1. Find or create a single persistent workpad comment for the issue:
   - Search existing comments for a marker header: `## Symphony Workpad`.
   - Ignore resolved comments while searching; only active/unresolved comments are eligible to be reused as the live workpad.
   - If found, reuse that comment; do not create a new workpad comment.
   - If not found, create one workpad comment and use it for all updates.
   - Persist the workpad comment ID and only write progress updates to that ID.
2. If arriving from `Todo`, do not delay on additional status transitions: the issue should already be `In Progress` before this step begins.
3. Immediately reconcile the workpad before new edits:
   - Check off items that are already done.
   - Expand/fix the plan so it is comprehensive for current scope.
   - Ensure `Acceptance Criteria` and `Validation` are current and still make sense for the task.
4. Start work by writing/updating a hierarchical plan in the workpad comment.
5. Ensure the workpad includes a compact environment stamp at the top as a code fence line:
   - Format: `<host>:<abs-workdir>@<short-sha>`
   - Example: `devbox-01:/home/dev-user/code/symphony-workspaces/ENG-42@7bdde33bc`
   - Do not include metadata already inferable from Linear issue fields (issue ID, status, branch, PR link).
6. Add explicit acceptance criteria and TODOs in checklist form in the same comment.
   - If changes are user-facing, include a UI walkthrough acceptance criterion that describes the end-to-end user path to validate.
   - If changes touch app files or app behavior, add explicit app-specific flow checks to `Acceptance Criteria` in the workpad (for example: launch path, changed interaction path, and expected result path).
   - If the ticket description/comment context includes `Validation`, `Test Plan`, or `Testing` sections, copy those requirements into the workpad `Acceptance Criteria` and `Validation` sections as required checkboxes (no optional downgrade).
7. Run a principal-style self-review of the plan and refine it in the comment.
8. Before implementing, capture a concrete reproduction signal and record it in the workpad `Notes` section (command/output, screenshot, or deterministic UI behavior).
9. Sync the working branch with latest `origin/main` before any code edits, then record the sync result in the workpad `Notes` with merge source(s), result (`clean` or `conflicts resolved`), and resulting `HEAD` short SHA.
10. Proceed to execution.

## PR feedback sweep protocol (required)

When a ticket has an attached PR, run this protocol before moving to `In Review`:

1. Identify the PR number from issue links/attachments.
2. Gather feedback from all channels:
   - Top-level PR comments.
   - Inline review comments on specific lines.
   - Review summaries/states (approved, changes requested, commented).
3. Treat every actionable reviewer comment (human or bot), including inline review comments, as blocking until one of these is true:
   - code/test/docs updated to address it, or
   - an explicit, justified pushback reply is posted on that thread.
4. Update the workpad plan/checklist to include each feedback item and its resolution status.
5. Re-run validation after feedback-driven changes and push updates.
6. Repeat this sweep until there are no outstanding actionable comments.

## Blocked-access escape hatch (required behavior)

Use this only when completion is blocked by missing required tools or missing auth/permissions that cannot be resolved in-session.

- GitHub is **not** a valid blocker by default. Always try fallback strategies first (alternate remote/auth mode, then continue publish/review flow).
- Do not move to `In Review` for GitHub access/auth until all fallback strategies have been attempted and documented in the workpad.
- If a non-GitHub required tool is missing, or required non-GitHub auth is unavailable, move the ticket to `In Review` with a short blocker brief in the workpad that includes:
  - what is missing,
  - why it blocks required acceptance/validation,
  - exact human action needed to unblock.
- Keep the brief concise and action-oriented; do not add extra top-level comments outside the workpad.

## Step 2: Execution phase (Todo -> In Progress -> In Review)

1. Determine current repo state (`branch`, `git status`, `HEAD`) and verify the kickoff sync with `origin/main` is already recorded in the workpad before implementation continues.
2. If current issue state is `Todo`, move it to `In Progress`; otherwise leave the current state unchanged.
3. Load the existing workpad comment and treat it as the active execution checklist.
   - Edit it liberally whenever reality changes (scope, risks, validation approach, discovered tasks).
4. Implement against the hierarchical TODOs and keep the comment current:
   - Check off completed items.
   - Add newly discovered items in the appropriate section.
   - Keep parent/child structure intact as scope evolves.
   - Update the workpad immediately after each meaningful milestone (for example: reproduction complete, code change landed, validation run, review feedback addressed).
   - Never leave completed work unchecked in the plan.
   - For tickets that started as `Todo` with an attached PR, run the full PR feedback sweep protocol immediately after kickoff and before new feature work.
5. Run validation/tests required for the scope.
   - Mandatory gate: execute all ticket-provided `Validation`/`Test Plan`/`Testing` requirements when present; treat unmet items as incomplete work.
   - Prefer a targeted proof that directly demonstrates the behavior you changed.
   - You may make temporary local proof edits to validate assumptions when this increases confidence.
   - Revert every temporary proof edit before commit/push.
   - Document these temporary proof steps and outcomes in the workpad `Validation`/`Notes` sections so reviewers can follow the evidence.
   - If changes are user-facing, exercise the affected path locally (dashboard/worker) and capture evidence (logs, screenshots, or CLI output) in the workpad.
6. Re-check all acceptance criteria and close any gaps.
7. Before every `git push` attempt, run the required validation for your scope and confirm it passes; if it fails, address issues and rerun until green, then commit and push changes.
8. Attach PR URL to the issue (prefer the Linear attachment; use the workpad comment only if attachment is unavailable).
   - Ensure the GitHub PR has label `symphony` (add it if missing).
9. Merge latest `origin/main` into the branch, resolve conflicts, and rerun checks.
10. Update the workpad comment with final checklist status and validation notes.
    - Mark completed plan/acceptance/validation checklist items as checked.
    - Add final handoff notes (commit + validation summary) in the same workpad comment.
    - Do not include the PR URL in the workpad comment; keep PR linkage on the issue via attachment/link fields.
    - Add a short `### Confusions` section at the bottom when any part of task execution was unclear/confusing, with concise bullets.
    - Do not post any additional completion summary comment.
11. Before moving to `In Review`, poll PR feedback and checks:
    - Read the PR `Manual QA Plan` comment (when present) and use it to sharpen UI/runtime test coverage for the current change.
    - Run the full PR feedback sweep protocol.
    - Confirm PR checks are passing (green) after the latest changes.
    - Confirm every required ticket-provided validation/test-plan item is explicitly marked complete in the workpad.
    - Repeat this check-address-verify loop until no outstanding comments remain and checks are fully passing.
    - Re-open and refresh the workpad before state transition so `Plan`, `Acceptance Criteria`, and `Validation` exactly match completed work.
12. Only then move the issue to `In Review`.
    - Exception: if blocked by missing required non-GitHub tools/auth per the blocked-access escape hatch, move to `In Review` with the blocker brief and explicit unblock actions.
13. For `Todo` tickets that already had a PR attached at kickoff:
    - Ensure all existing PR feedback was reviewed and resolved, including inline review comments (code changes or explicit, justified pushback response).
    - Ensure the branch was pushed with any required updates.
    - Then move to `In Review`.

## Step 3: In Review and merge handling

1. When the issue is in `In Review`, do not code or change ticket content.
2. Poll for updates as needed, including GitHub PR review comments from humans and bots.
3. If review feedback requires changes, move the issue to `Rework` and follow the rework flow.
4. If approved, the human moves the issue to `Merging`.
5. When the issue is in `Merging`, follow the land procedure below. Do not call `gh pr merge` directly without verifying checks and approval.
6. After merge is complete, move the issue to `Done`.

## Land procedure (used when entering `Merging`)

1. Confirm the PR is approved and all required status checks are green.
2. Sync the branch with latest `origin/main` and resolve any conflicts; rerun required validation.
3. Merge the PR (squash unless the repo convention says otherwise). Prefer the GitHub auto-merge path (for example `gh pr merge --squash --auto`) so the merge only completes once checks pass.
4. Wait for the merge to complete, then delete the remote branch.
5. Record the merge commit SHA in the workpad and move the issue to `Done`.
6. If any step fails (checks go red, merge conflicts appear, auto-merge disabled), stop, record the failure in the workpad, and move the issue to `Rework` with a brief note describing what blocked the land.

## Step 4: Rework handling

1. Treat `Rework` as a full approach reset, not incremental patching.
2. Re-read the full issue body and all human comments; explicitly identify what will be done differently this attempt.
3. Close the existing PR tied to the issue.
4. Remove the existing `## Symphony Workpad` comment from the issue.
5. Create a fresh branch from `origin/main`.
6. Start over from the normal kickoff flow:
   - If current issue state is `Todo`, move it to `In Progress`; otherwise keep the current state.
   - Create a new bootstrap `## Symphony Workpad` comment.
   - Build a fresh plan/checklist and execute end-to-end.

## Completion bar before In Review

- Step 1/2 checklist is fully complete and accurately reflected in the single workpad comment.
- Acceptance criteria and required ticket-provided validation items are complete.
- Validation/tests are green for the latest commit.
- PR feedback sweep is complete and no actionable comments remain.
- PR checks are green, branch is pushed, and PR is linked on the issue.
- Required PR metadata is present (`symphony` label).
- If user-facing, runtime validation evidence is captured in the workpad.

## Guardrails

- If the branch PR is already closed/merged, do not reuse that branch or prior implementation state for continuation.
- For closed/merged branch PRs, create a new branch from `origin/main` and restart from reproduction/planning as if starting fresh.
- If issue state is `Backlog`, do not modify it; wait for human to move to `Todo`.
- Do not edit the issue body/description for planning or progress tracking.
- Use exactly one persistent workpad comment (`## Symphony Workpad`) per issue.
- Temporary proof edits are allowed only for local verification and must be reverted before commit.
- If out-of-scope improvements are found, create a separate Backlog issue rather than expanding current scope, and include a clear title/description/acceptance criteria, same-project assignment, a `related` link to the current issue, and `blockedBy` when the follow-up depends on the current issue.
- Do not move to `In Review` unless the `Completion bar before In Review` is satisfied.
- In `In Review`, do not make changes; wait and poll.
- If state is terminal (`Done`), do nothing and shut down.
- Keep issue text concise, specific, and reviewer-oriented.
- If blocked and no workpad exists yet, add one blocker comment describing blocker, impact, and next unblock action.

## Workpad template

Use this exact structure for the persistent workpad comment and keep it updated in place throughout execution:

````md
## Symphony Workpad

```text
<hostname>:<abs-path>@<short-sha>
```

### Plan

- [ ] 1\. Parent task
  - [ ] 1.1 Child task
  - [ ] 1.2 Child task
- [ ] 2\. Parent task

### Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2

### Validation

- [ ] targeted tests: `<command>`

### Notes

- <short progress note with timestamp>

### Confusions

- <only include when something was confusing during execution>
````
