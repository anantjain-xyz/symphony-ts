import type { Issue, ParsedWorkflow } from '@symphony/shared';

export function makeTestIssue(overrides: Partial<Issue> & Pick<Issue, 'id' | 'identifier'>): Issue {
  return {
    title: 'test issue',
    description: null,
    priority: 1,
    state: 'todo',
    branch: null,
    labels: [],
    blockers: [],
    pr_urls: [],
    ...overrides,
  };
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
}): ParsedWorkflow {
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
