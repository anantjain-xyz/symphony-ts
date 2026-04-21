import { describe, it, expect } from 'vitest';
import { GraphQLClient } from 'graphql-request';
import { createLinearClient, normalize, LinearAuthError, LinearRateLimitError } from './linear.js';

function stubClient(impl: (op: string, vars: unknown) => unknown): GraphQLClient {
  return {
    request: (
      doc: { definitions?: Array<{ name?: { value?: string } }> } | string,
      vars?: unknown,
    ) => {
      const opName =
        typeof doc === 'string'
          ? extractOpName(doc)
          : (doc.definitions?.[0]?.name?.value ?? 'unknown');
      return Promise.resolve(impl(opName, vars));
    },
  } as unknown as GraphQLClient;
}
function extractOpName(s: string): string {
  return s.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? 'unknown';
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
  relations: { nodes: [{ type: 'blocked_by', relatedIssue: { identifier: 'ENG-40' } }] },
};

const ENG41_URGENT = {
  ...ENG42,
  id: 'uuid-eng-41',
  identifier: 'ENG-41',
  title: 'Hotfix',
  priority: 1, // urgent
  state: { name: 'In Progress' },
  relations: { nodes: [] },
};

describe('normalize', () => {
  it('lowercases state and pulls blockers from blocked_by relations', () => {
    const issue = normalize(ENG42);
    expect(issue.state).toBe('todo');
    expect(issue.blockers).toEqual(['ENG-40']);
    expect(issue.labels).toEqual(['backend']);
    expect(issue.branch).toBe('eng-42-fix-bug');
  });

  it('handles null branch, labels, relations', () => {
    const issue = normalize({
      id: 'x',
      identifier: 'X-1',
      title: 't',
      description: null,
      priority: 0,
      branchName: null,
      state: { name: 'Backlog' },
      labels: null,
      relations: null,
    });
    expect(issue.state).toBe('backlog');
    expect(issue.branch).toBeNull();
    expect(issue.labels).toEqual([]);
    expect(issue.blockers).toEqual([]);
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
        relations: null,
      }),
    ).toThrow(/no state/);
  });
});

describe('createLinearClient', () => {
  it('fetchActive sorts urgent before normal, treats priority 0 as lowest', async () => {
    const noPriority = { ...ENG42, id: 'np', identifier: 'X-99', priority: 0 };
    const client = createLinearClient({
      endpoint: 'http://stub',
      apiKey: 'k',
      activeStates: ['todo', 'in progress'],
      terminalStates: ['done'],
      client: stubClient(() => ({ issues: { nodes: [ENG42, ENG41_URGENT, noPriority] } })),
    });
    const issues = await client.fetchActive();
    expect(issues.map((i) => i.identifier)).toEqual(['ENG-41', 'ENG-42', 'X-99']);
  });

  it('fetchActive returns [] when no states configured', async () => {
    const client = createLinearClient({
      endpoint: 'http://stub',
      apiKey: 'k',
      activeStates: [],
      terminalStates: ['done'],
      client: stubClient(() => {
        throw new Error('should not be called');
      }),
    });
    expect(await client.fetchActive()).toEqual([]);
  });

  it('fetchById returns null when issue missing', async () => {
    const client = createLinearClient({
      endpoint: 'http://stub',
      apiKey: 'k',
      activeStates: ['todo'],
      terminalStates: ['done'],
      client: stubClient(() => ({ issue: null })),
    });
    expect(await client.fetchById('missing')).toBeNull();
  });

  it('classifies 401 as LinearAuthError', async () => {
    const client = createLinearClient({
      endpoint: 'http://stub',
      apiKey: 'k',
      activeStates: ['todo'],
      terminalStates: ['done'],
      client: stubClient(() => {
        const err = new Error('unauthorized') as Error & { response: { status: number } };
        err.response = { status: 401 };
        throw err;
      }),
    });
    await expect(client.fetchActive()).rejects.toBeInstanceOf(LinearAuthError);
  });

  it('classifies 429 as LinearRateLimitError with retry-after', async () => {
    const client = createLinearClient({
      endpoint: 'http://stub',
      apiKey: 'k',
      activeStates: ['todo'],
      terminalStates: ['done'],
      client: stubClient(() => {
        const err = new Error('rate limited') as Error & { response: unknown };
        err.response = {
          status: 429,
          headers: { get: (k: string) => (k === 'retry-after' ? '7' : null) },
        };
        throw err;
      }),
    });
    await expect(client.fetchActive()).rejects.toMatchObject({
      name: 'LinearRateLimitError',
      retryAfterMs: 7000,
    });
  });
});
