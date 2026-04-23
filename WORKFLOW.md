---
tracker:
  kind: linear
  api_key: ${LINEAR_API_KEY}
  active_states:
    - todo
    - in progress
  terminal_states:
    - done
    - cancelled
    - duplicate

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
  backend: codex
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
  # default | acceptEdits | bypassPermissions | plan
  permission_mode: acceptEdits
  allowed_tools: []
  disallowed_tools: []
  add_dirs: []
  turn_timeout_ms: 3600000
---

You are working on issue **{{identifier}}: {{title}}**.

State: {{state}}
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

Open a pull request when ready. Update the Linear issue with a comment linking the PR, then transition the issue from `todo` to `in progress` so this attempt isn't re-dispatched while the PR awaits review.
