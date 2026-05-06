import { GraphQLClient } from 'graphql-request';
import { describe, expect, it, vi } from 'vitest';
import { liveConfig, resolveConfig } from '../config/resolve.js';
import { makeTestWorkflow } from '../db/test-helpers.js';
import {
  createLinearClient,
  LinearAuthError,
  LinearRateLimitError,
  LinearTimeoutError,
  normalize,
} from './linear.js';

function mkConfig(
  overrides: {
    activeStates?: string[];
    terminalStates?: string[];
    endpoint?: string;
    apiKey?: string;
    identifierPrefix?: string;
    projectId?: string;
  } = {},
) {
  return resolveConfig(makeTestWorkflow({ sourceHash: 'linear-test', ...overrides }));
}

interface RequestArg {
  document: { definitions?: Array<{ name?: { value?: string } }> } | string;
  variables?: unknown;
  signal?: AbortSignal;
}

type Impl = (op: string, vars: unknown, signal: AbortSignal | undefined) => unknown;

function stubClient(impl: Impl): GraphQLClient {
  return {
    request: (arg: RequestArg) => {
      const doc = arg.document;
      const opName =
        typeof doc === 'string'
          ? extractOpName(doc)
          : (doc.definitions?.[0]?.name?.value ?? 'unknown');
      try {
        const result = impl(opName, arg.variables, arg.signal);
        return Promise.resolve(result);
      } catch (err) {
        return Promise.reject(err);
      }
    },
  } as unknown as GraphQLClient;
}
function extractOpName(s: string): string {
  return s.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? 'unknown';
}

function rateLimitError(retryAfter: string | null = '7'): Error {
  const err = new Error('rate limited') as Error & { response: unknown };
  err.response = {
    status: 429,
    headers: { get: (k: string) => (k.toLowerCase() === 'retry-after' ? retryAfter : null) },
  };
  return err;
}

function serverError(status = 500): Error {
  const err = new Error(`server ${status}`) as Error & { response: { status: number } };
  err.response = { status };
  return err;
}

function networkError(): Error {
  // graphql-request throws a plain Error wrapping the underlying fetch
  // failure when the transport itself fails (no .response attached).
  return new Error('fetch failed: ECONNRESET');
}

const ENG42 = {
  id: 'uuid-eng-42',
  identifier: 'ENG-42',
  title: 'Fix the bug',
  description: 'Repro: ...',
  priority: 2,
  branchName: 'eng-42-fix-bug',
  state: { name: 'Todo' },
  labels: { nodes: [{ name: 'backend' }] },
  inverseRelations: {
    nodes: [
      {
        type: 'blocks',
        issue: { identifier: 'ENG-40', state: { type: 'started' } },
      },
    ],
  },
  attachments: null,
};

const ENG41_URGENT = {
  ...ENG42,
  id: 'uuid-eng-41',
  identifier: 'ENG-41',
  title: 'Hotfix',
  priority: 1, // urgent
  state: { name: 'In Progress' },
  inverseRelations: { nodes: [] },
};

describe('normalize', () => {
  it('lowercases state and pulls blockers from inverseRelations (type=blocks)', () => {
    // Linear represents "ENG-42 blocked by ENG-40" as a single IssueRelation
    // owned by ENG-40 (type=blocks, relatedIssue=ENG-42). From ENG-42's side
    // it surfaces under inverseRelations with `issue` pointing at the blocker.
    const issue = normalize(ENG42);
    expect(issue.state).toBe('todo');
    expect(issue.blockers).toEqual(['ENG-40']);
    expect(issue.labels).toEqual(['backend']);
    expect(issue.branch).toBe('eng-42-fix-bug');
  });

  it('handles null branch, labels, inverseRelations', () => {
    const issue = normalize({
      id: 'x',
      identifier: 'X-1',
      title: 't',
      description: null,
      priority: 0,
      branchName: null,
      state: { name: 'Backlog' },
      labels: null,
      inverseRelations: null,
      attachments: null,
    });
    expect(issue.state).toBe('backlog');
    expect(issue.branch).toBeNull();
    expect(issue.labels).toEqual([]);
    expect(issue.blockers).toEqual([]);
    expect(issue.pr_urls).toEqual([]);
  });

  it('throws when Linear issue has no state', () => {
    expect(() =>
      normalize({
        id: 'x',
        identifier: 'X-1',
        title: 't',
        description: null,
        priority: 0,
        branchName: null,
        state: null,
        labels: null,
        inverseRelations: null,
        attachments: null,
      }),
    ).toThrow(/no state/);
  });

  it('skips blockers whose source issue is completed or canceled', () => {
    const issue = normalize({
      ...ENG42,
      inverseRelations: {
        nodes: [
          { type: 'blocks', issue: { identifier: 'ENG-40', state: { type: 'started' } } },
          { type: 'blocks', issue: { identifier: 'ENG-39', state: { type: 'completed' } } },
          { type: 'blocks', issue: { identifier: 'ENG-38', state: { type: 'canceled' } } },
          { type: 'blocks', issue: { identifier: 'ENG-37', state: { type: 'backlog' } } },
          { type: 'blocks', issue: { identifier: 'ENG-36', state: null } },
          // Non-blocking inverse relations (e.g. `related`, `duplicate`) must
          // not contribute to blockers even when the source issue is active.
          { type: 'related', issue: { identifier: 'ENG-35', state: { type: 'started' } } },
        ],
      },
    });
    expect(issue.blockers).toEqual(['ENG-40', 'ENG-37', 'ENG-36']);
  });

  it('extracts GitHub PR URLs from attachments and dedups them', () => {
    const issue = normalize({
      ...ENG42,
      attachments: {
        nodes: [
          { url: 'https://github.com/acme/repo/pull/42' },
          { url: 'https://github.com/acme/repo/pull/42' }, // dup
          { url: 'https://github.com/acme/repo/pull/57/files' },
          { url: 'https://figma.com/file/abc' }, // non-PR
          { url: 'https://github.com/acme/repo/issues/9' }, // issue, not PR
        ],
      },
    });
    expect(issue.pr_urls).toEqual([
      'https://github.com/acme/repo/pull/42',
      'https://github.com/acme/repo/pull/57/files',
    ]);
  });
});

describe('createLinearClient', () => {
  it('fetchActive sorts urgent before normal, treats priority 0 as lowest', async () => {
    const noPriority = { ...ENG42, id: 'np', identifier: 'X-99', priority: 0 };
    const client = createLinearClient({
      config: mkConfig({ activeStates: ['todo', 'in progress'] }),
      client: stubClient(() => ({ issues: { nodes: [ENG42, ENG41_URGENT, noPriority] } })),
      sleep: async (_ms: number) => {},
    });
    const issues = await client.fetchActive();
    expect(issues.map((i) => i.identifier)).toEqual(['ENG-41', 'ENG-42', 'X-99']);
  });

  it('fetchActive returns [] when no states configured', async () => {
    const client = createLinearClient({
      config: mkConfig({ activeStates: [] }),
      client: stubClient(() => {
        throw new Error('should not be called');
      }),
      sleep: async (_ms: number) => {},
    });
    expect(await client.fetchActive()).toEqual([]);
  });

  it('fetchById returns null when issue missing', async () => {
    const client = createLinearClient({
      config: mkConfig(),
      client: stubClient(() => ({ issue: null })),
      sleep: async (_ms: number) => {},
    });
    expect(await client.fetchById('missing')).toBeNull();
  });

  it('fetchById returns null when Linear reports Entity not found', async () => {
    // Real Linear surfaces an unknown id as a GraphQL INPUT_ERROR (HTTP 200
    // with errors[]) rather than `{ issue: null }`. Reproduces the warning
    // logged by `confirmNotActive` against stale retry_queue rows.
    const calls = vi.fn(() => {
      const err = new Error('Entity not found: Issue') as Error & { response: unknown };
      err.response = {
        status: 200,
        errors: [
          {
            message: 'Entity not found: Issue',
            path: ['issue'],
            extensions: {
              type: 'invalid input',
              code: 'INPUT_ERROR',
              statusCode: 400,
              userError: true,
              userPresentableMessage: 'Could not find referenced Issue.',
            },
          },
        ],
      };
      throw err;
    });
    const client = createLinearClient({
      config: mkConfig({ endpoint: 'http://stub', apiKey: 'k' }),
      client: stubClient(calls),
      sleep: async (_ms: number) => {},
    });
    expect(await client.fetchById('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')).toBeNull();
    // Single call: don't burn retries on a hard "not found".
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('identifier_prefix scopes the GraphQL query to the team and drops off-team issues defensively', async () => {
    // Polyblind + Symphony share a Linear workspace; the worker must only see
    // PB-* issues when configured for the Polyblind team. The team-key filter
    // must be in the GraphQL query — without it, a busy workspace can fill the
    // `first: 100` page with off-team issues and starve the configured team.
    const PB7 = { ...ENG42, id: 'uuid-pb-7', identifier: 'PB-7' };
    const PB8 = { ...ENG42, id: 'uuid-pb-8', identifier: 'PB-8' };
    const SYM3 = { ...ENG42, id: 'uuid-sym-3', identifier: 'SYM-3' };

    const seenVars: Array<Record<string, unknown>> = [];
    // Server returns the rogue SYM-3 too; the post-fetch filter is the
    // defense-in-depth check that the test asserts also runs.
    const stub = (op: string, vars: unknown) => {
      seenVars.push(vars as Record<string, unknown>);
      if (op === 'SymphonyIssueById') return { issue: SYM3 };
      return { issues: { nodes: [PB7, SYM3, PB8] } };
    };

    const client = createLinearClient({
      config: mkConfig({
        activeStates: ['todo'],
        terminalStates: ['done'],
        identifierPrefix: 'PB-',
      }),
      client: stubClient(stub),
      sleep: async (_ms: number) => {},
    });

    const active = await client.fetchActive();
    expect(active.map((i) => i.identifier)).toEqual(['PB-7', 'PB-8']);
    expect(seenVars[0]).toMatchObject({ teamKey: 'PB' });

    const terminal = await client.fetchTerminal();
    expect(terminal.map((i) => i.identifier)).toEqual(['PB-7', 'PB-8']);
    expect(seenVars[1]).toMatchObject({ teamKey: 'PB' });

    // fetchById of an off-team issue is treated as "not ours".
    expect(await client.fetchById('uuid-sym-3')).toBeNull();
  });

  it('project_id scopes the GraphQL query to the project and gates fetchById on project membership', async () => {
    // The scope-by-project knob (SYM-34): when set, only issues belonging to
    // that Linear project should reach the worker. Mirrors the team-prefix
    // path: the filter has to live in the GraphQL query, not just the
    // post-fetch normalize step, otherwise a busy workspace fills the
    // `first: 100` page with off-project issues and starves the configured
    // project.
    const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
    const OTHER_PROJECT_ID = '22222222-2222-4222-8222-222222222222';
    const PB7_INPROJECT = {
      ...ENG42,
      id: 'uuid-pb-7',
      identifier: 'PB-7',
      project: { id: PROJECT_ID },
    };
    const PB8_OFFPROJECT = {
      ...ENG42,
      id: 'uuid-pb-8',
      identifier: 'PB-8',
      project: { id: OTHER_PROJECT_ID },
    };

    const seenVars: Array<Record<string, unknown>> = [];
    const stub = (op: string, vars: unknown) => {
      seenVars.push(vars as Record<string, unknown>);
      if (op === 'SymphonyIssueById') {
        // Caller passes a real issue id; respond with the off-project one to
        // exercise the defense-in-depth gate in fetchById.
        return { issue: PB8_OFFPROJECT };
      }
      // Server's filter is honoured here — only the in-project issue comes
      // back. Confirms the GraphQL filter is what's doing the work.
      return { issues: { nodes: [PB7_INPROJECT] } };
    };

    const client = createLinearClient({
      config: mkConfig({
        activeStates: ['todo'],
        terminalStates: ['done'],
        projectId: PROJECT_ID,
      }),
      client: stubClient(stub),
      sleep: async (_ms: number) => {},
    });

    const active = await client.fetchActive();
    expect(active.map((i) => i.identifier)).toEqual(['PB-7']);
    expect(seenVars[0]).toMatchObject({ projectId: PROJECT_ID });

    const terminal = await client.fetchTerminal();
    expect(terminal.map((i) => i.identifier)).toEqual(['PB-7']);
    expect(seenVars[1]).toMatchObject({ projectId: PROJECT_ID });

    expect(await client.fetchById('uuid-pb-8')).toBeNull();
  });

  it('project_id and identifier_prefix compose into a single GraphQL filter', async () => {
    const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
    const seenVars: Array<Record<string, unknown>> = [];
    const client = createLinearClient({
      config: mkConfig({
        activeStates: ['todo'],
        identifierPrefix: 'PB-',
        projectId: PROJECT_ID,
      }),
      client: stubClient((_op, vars) => {
        seenVars.push(vars as Record<string, unknown>);
        return { issues: { nodes: [] } };
      }),
      sleep: async (_ms: number) => {},
    });
    await client.fetchActive();
    expect(seenVars[0]).toMatchObject({ teamKey: 'PB', projectId: PROJECT_ID });
  });

  it('omitting identifier_prefix returns every fetched issue unchanged', async () => {
    const PB7 = { ...ENG42, id: 'uuid-pb-7', identifier: 'PB-7' };
    const SYM3 = { ...ENG42, id: 'uuid-sym-3', identifier: 'SYM-3' };
    const client = createLinearClient({
      config: mkConfig({ activeStates: ['todo'] }),
      client: stubClient(() => ({ issues: { nodes: [PB7, SYM3] } })),
      sleep: async (_ms: number) => {},
    });
    const active = await client.fetchActive();
    expect(active.map((i) => i.identifier).sort()).toEqual(['PB-7', 'SYM-3']);
  });

  it('reads activeStates / terminalStates from live config on every call', async () => {
    // Hot-reload regression guard. Before SYM-17 the tracker captured the
    // states at construction time, so a SIGHUP-driven swap was silently
    // ignored — fetchActive kept polling the old state set.
    const live = liveConfig(
      resolveConfig(
        makeTestWorkflow({
          sourceHash: 'before',
          activeStates: ['todo'],
          terminalStates: ['done'],
        }),
      ),
    );
    const seenVars: Array<Record<string, unknown>> = [];
    const client = createLinearClient({
      config: live,
      client: stubClient((_op, vars) => {
        seenVars.push(vars as Record<string, unknown>);
        return { issues: { nodes: [] } };
      }),
      sleep: async (_ms: number) => {},
    });
    await client.fetchActive();
    expect(seenVars[0]).toEqual({ s0: 'todo' });

    live.swap(
      resolveConfig(
        makeTestWorkflow({
          sourceHash: 'after',
          activeStates: ['todo', 'in progress'],
          terminalStates: ['done', 'canceled'],
        }),
      ),
    );

    await client.fetchActive();
    expect(seenVars[1]).toEqual({ s0: 'todo', s1: 'in progress' });

    await client.fetchTerminal();
    expect(seenVars[2]).toEqual({ s0: 'done', s1: 'canceled' });
  });
});

describe('createLinearClient – resilience', () => {
  it('401 throws LinearAuthError immediately and does not retry', async () => {
    const calls = vi.fn(() => {
      const err = new Error('unauthorized') as Error & { response: { status: number } };
      err.response = { status: 401 };
      throw err;
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const client = createLinearClient({
      config: mkConfig(),
      client: stubClient(calls),
      sleep,
      maxAttempts: 3,
    });
    await expect(client.fetchActive()).rejects.toBeInstanceOf(LinearAuthError);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('403 throws LinearAuthError immediately and does not retry', async () => {
    const calls = vi.fn(() => {
      const err = new Error('forbidden') as Error & { response: { status: number } };
      err.response = { status: 403 };
      throw err;
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const client = createLinearClient({
      config: mkConfig(),
      client: stubClient(calls),
      sleep,
    });
    await expect(client.fetchActive()).rejects.toBeInstanceOf(LinearAuthError);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('429 honours Retry-After, sleeps, retries, then succeeds', async () => {
    let n = 0;
    const calls = vi.fn(() => {
      n += 1;
      if (n === 1) throw rateLimitError('7');
      return { issues: { nodes: [ENG42] } };
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const client = createLinearClient({
      config: mkConfig(),
      client: stubClient(calls),
      sleep,
      maxAttempts: 3,
    });
    const issues = await client.fetchActive();
    expect(issues.map((i) => i.identifier)).toEqual(['ENG-42']);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    // First sleep should be ~7000ms (Retry-After) plus small additive jitter (≤250ms).
    const slept = sleep.mock.calls[0]?.[0] as number;
    expect(slept).toBeGreaterThanOrEqual(7000);
    expect(slept).toBeLessThan(7000 + 250);
  });

  it('429 honours HTTP-date Retry-After values', async () => {
    const now = Date.parse('Wed, 21 Oct 2015 07:27:48 GMT');
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
    const calls = vi.fn(() => {
      throw rateLimitError('Wed, 21 Oct 2015 07:28:00 GMT');
    });
    const client = createLinearClient({
      config: mkConfig(),
      client: stubClient(calls),
      sleep: async (_ms: number) => {},
      maxAttempts: 1,
    });
    try {
      await expect(client.fetchActive()).rejects.toMatchObject({
        name: 'LinearRateLimitError',
        retryAfterMs: 12000,
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it('429 falls back to default Retry-After when header missing/invalid', async () => {
    const calls = vi.fn(() => {
      throw rateLimitError(null);
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const client = createLinearClient({
      config: mkConfig(),
      client: stubClient(calls),
      sleep,
      maxAttempts: 2,
    });
    await expect(client.fetchActive()).rejects.toMatchObject({
      name: 'LinearRateLimitError',
      retryAfterMs: 5000,
    });
    expect(calls).toHaveBeenCalledTimes(2);
    // Sleep was issued for the first failure with the default 5s value.
    const slept = sleep.mock.calls[0]?.[0] as number;
    expect(slept).toBeGreaterThanOrEqual(5000);
    expect(slept).toBeLessThan(5000 + 250);
  });

  it('429 exhausted across maxAttempts surfaces LinearRateLimitError', async () => {
    const calls = vi.fn(() => {
      throw rateLimitError('3');
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const client = createLinearClient({
      config: mkConfig(),
      client: stubClient(calls),
      sleep,
      maxAttempts: 3,
    });
    await expect(client.fetchActive()).rejects.toMatchObject({
      name: 'LinearRateLimitError',
      retryAfterMs: 3000,
    });
    expect(calls).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('5xx retries with exponential backoff and recovers', async () => {
    let n = 0;
    const calls = vi.fn(() => {
      n += 1;
      if (n < 3) throw serverError(503);
      return { issues: { nodes: [ENG42] } };
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const client = createLinearClient({
      config: mkConfig(),
      client: stubClient(calls),
      sleep,
      maxAttempts: 3,
    });
    const issues = await client.fetchActive();
    expect(issues.map((i) => i.identifier)).toEqual(['ENG-42']);
    expect(calls).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    // First sleep: base=500ms with up to +50% jitter -> [500, 750).
    const s1 = sleep.mock.calls[0]?.[0] as number;
    expect(s1).toBeGreaterThanOrEqual(500);
    expect(s1).toBeLessThan(750);
    // Second sleep: 1000ms with up to +50% jitter -> [1000, 1500).
    const s2 = sleep.mock.calls[1]?.[0] as number;
    expect(s2).toBeGreaterThanOrEqual(1000);
    expect(s2).toBeLessThan(1500);
  });

  it('caps transient backoff after jitter', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    const calls = vi.fn(() => {
      throw serverError(503);
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const client = createLinearClient({
      config: mkConfig(),
      client: stubClient(calls),
      sleep,
      maxAttempts: 6,
    });
    try {
      await expect(client.fetchActive()).rejects.toThrow(/server 503/);
      expect(sleep).toHaveBeenCalledTimes(5);
      for (const [ms] of sleep.mock.calls) {
        expect(ms).toBeLessThanOrEqual(5000);
      }
    } finally {
      random.mockRestore();
    }
  });

  it('5xx exhausted re-throws the underlying error', async () => {
    const calls = vi.fn(() => {
      throw serverError(500);
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const client = createLinearClient({
      config: mkConfig(),
      client: stubClient(calls),
      sleep,
      maxAttempts: 3,
    });
    await expect(client.fetchActive()).rejects.toThrow(/server 500/);
    expect(calls).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('network error (no response) retries then succeeds', async () => {
    let n = 0;
    const calls = vi.fn(() => {
      n += 1;
      if (n === 1) throw networkError();
      return { issues: { nodes: [ENG42] } };
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const client = createLinearClient({
      config: mkConfig(),
      client: stubClient(calls),
      sleep,
      maxAttempts: 3,
    });
    const issues = await client.fetchActive();
    expect(issues.map((i) => i.identifier)).toEqual(['ENG-42']);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('network error exhausted re-throws the underlying error', async () => {
    const calls = vi.fn(() => {
      throw networkError();
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const client = createLinearClient({
      config: mkConfig(),
      client: stubClient(calls),
      sleep,
      maxAttempts: 3,
    });
    await expect(client.fetchActive()).rejects.toThrow(/fetch failed/);
    expect(calls).toHaveBeenCalledTimes(3);
  });

  it('per-request timeout aborts the in-flight call and surfaces LinearTimeoutError', async () => {
    // Stub that never resolves on its own, but rejects with AbortError when the
    // abort signal fires – mirroring how fetch propagates AbortController.
    const calls = vi.fn(
      (_op: string, _vars: unknown, signal: AbortSignal | undefined) =>
        new Promise((_res, rej) => {
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted') as Error & { name: string };
            err.name = 'AbortError';
            rej(err);
          });
        }),
    );
    const sleep = vi.fn(async (_ms: number) => {});
    const client = createLinearClient({
      config: mkConfig(),
      client: stubClient(calls),
      sleep,
      requestTimeoutMs: 5,
      maxAttempts: 1,
    });
    await expect(client.fetchActive()).rejects.toBeInstanceOf(LinearTimeoutError);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('timeout is treated as transient and retried up to maxAttempts', async () => {
    const calls = vi.fn(
      (_op: string, _vars: unknown, signal: AbortSignal | undefined) =>
        new Promise((_res, rej) => {
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted') as Error & { name: string };
            err.name = 'AbortError';
            rej(err);
          });
        }),
    );
    const sleep = vi.fn(async (_ms: number) => {});
    const client = createLinearClient({
      config: mkConfig(),
      client: stubClient(calls),
      sleep,
      requestTimeoutMs: 5,
      maxAttempts: 3,
    });
    await expect(client.fetchActive()).rejects.toBeInstanceOf(LinearTimeoutError);
    expect(calls).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('passes the AbortController signal through to the underlying client', async () => {
    let captured: AbortSignal | undefined;
    const client = createLinearClient({
      config: mkConfig(),
      client: stubClient((_op, _vars, signal) => {
        captured = signal;
        return { issues: { nodes: [] } };
      }),
      sleep: async (_ms: number) => {},
    });
    await client.fetchActive();
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured?.aborted).toBe(false);
  });
});
