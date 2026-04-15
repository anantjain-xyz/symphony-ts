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
    git init -q
    git remote add origin "$REPO_URL" || true
  before_run: |
    echo "starting attempt for ${ISSUE_IDENTIFIER}"
  after_run: |
    echo "finished attempt for ${ISSUE_IDENTIFIER}"
  timeout_ms: 60000

agent:
  max_concurrent_agents: 4
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    in progress: 2

codex:
  command: codex
  approval_policy: never
  thread_sandbox: workspace-write
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

Open a pull request when ready. Update the Linear issue with a comment linking the PR.
