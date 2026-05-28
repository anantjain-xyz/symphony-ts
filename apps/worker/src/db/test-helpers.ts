import type { Issue, ParsedRepos, ParsedWorkflow } from '@symphony/shared';
import { parseReposSource } from '../config/repos.js';

export function makeTestIssue(overrides: Partial<Issue> & Pick<Issue, 'id' | 'identifier'>): Issue {
  return {
    title: 'test issue',
    description: null,
    priority: 1,
    state: 'todo',
    branch: null,
    // Default to the test repo's routing label so issues are eligible for
    // dispatch in tests that exercise the orchestrator loop. Tests asserting
    // on unlabeled-issue behavior override this with `labels: []`.
    labels: ['repo:test'],
    blockers: [],
    pr_urls: [],
    ...overrides,
  };
}

/**
 * Minimal repos.md content used in tests. Matches the default label on
 * `makeTestIssue` so an unmodified test issue dispatches cleanly.
 */
export function makeTestRepos(): ParsedRepos {
  return parseReposSource(`---
repos:
  - name: test
    repo_url: https://example.com/test
---`);
}

export function makeTestWorkflow(opts: {
  sourceHash: string;
  wsRoot?: string;
  codexCommand?: string;
  endpoint?: string;
  apiKey?: string;
  activeStates?: string[];
  terminalStates?: string[];
  identifierPrefix?: string;
  projectId?: string;
  projectIds?: string[];
}): ParsedWorkflow {
  const projectIds = opts.projectIds ?? (opts.projectId ? [opts.projectId] : undefined);
  return {
    sourceHash: opts.sourceHash,
    promptTemplate: 'do work on {{identifier}}',
    frontMatter: {
      tracker: {
        kind: 'linear',
        endpoint: opts.endpoint ?? 'http://stub',
        api_key: opts.apiKey ?? 'k',
        active_states: opts.activeStates ?? ['todo'],
        terminal_states: opts.terminalStates ?? ['done'],
        ...(opts.identifierPrefix ? { identifier_prefix: opts.identifierPrefix } : {}),
        ...(projectIds && projectIds.length > 0
          ? { project_id: projectIds as [string, ...string[]] }
          : {}),
      },
      polling: { interval_ms: 30000 },
      workspace: { root: opts.wsRoot ?? '/tmp/symphony-tests' },
      hooks: { timeout_ms: 60000 },
      agent: {
        backend: 'codex',
        max_concurrent_agents: 4,
        max_retry_backoff_ms: 1000,
        max_concurrent_agents_by_state: {},
      },
      codex: {
        command: opts.codexCommand ?? 'codex',
        approval_policy: 'never',
        thread_sandbox: 'workspace-write',
        turn_sandbox_policy: 'inherit',
        turn_timeout_ms: 3600000,
        network_access: false,
      },
      claude: {
        command: 'claude',
        permission_mode: 'acceptEdits',
        allowed_tools: [],
        disallowed_tools: [],
        add_dirs: [],
        turn_timeout_ms: 3600000,
      },
    },
  };
}
