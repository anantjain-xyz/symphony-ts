import { Issue } from '@symphony/shared';
import { GraphQLClient, gql } from 'graphql-request';

// =========================================================================
// Public interface
// =========================================================================

export interface TrackerClient {
  preflight(): Promise<void>;
  fetchActive(): Promise<Issue[]>;
  fetchById(id: string): Promise<Issue | null>;
  fetchTerminal(): Promise<Issue[]>;
}

export interface LinearClientOptions {
  endpoint: string;
  apiKey: string;
  activeStates: string[]; // lowercased
  terminalStates: string[]; // lowercased
  /** Inject a custom client for tests. */
  client?: GraphQLClient;
}

export class LinearAuthError extends Error {
  override readonly name = 'LinearAuthError';
}
export class LinearRateLimitError extends Error {
  override readonly name = 'LinearRateLimitError';
  constructor(public readonly retryAfterMs: number) {
    super(`Linear rate limited; retry after ${retryAfterMs}ms`);
  }
}

// =========================================================================
// Implementation
// =========================================================================

export function createLinearClient(opts: LinearClientOptions): TrackerClient {
  const client =
    opts.client ??
    new GraphQLClient(opts.endpoint, {
      headers: { authorization: opts.apiKey },
    });

  return {
    async preflight() {
      try {
        await client.request<{ viewer: { id: string } }>(VIEWER_QUERY);
      } catch (err) {
        throw classify(err);
      }
    },

    async fetchActive() {
      const issues = await fetchByStateNames(client, opts.activeStates);
      return issues.sort(byPriorityThenIdentifier);
    },

    async fetchTerminal() {
      return fetchByStateNames(client, opts.terminalStates);
    },

    async fetchById(id: string) {
      try {
        const data = await client.request<{ issue: LinearIssueNode | null }>(ISSUE_BY_ID_QUERY, {
          id,
        });
        return data.issue ? normalize(data.issue) : null;
      } catch (err) {
        throw classify(err);
      }
    },
  };
}

async function fetchByStateNames(client: GraphQLClient, states: string[]): Promise<Issue[]> {
  if (states.length === 0) return [];
  // Linear's StringComparator doesn't support `inIgnoreCase`, so we OR together
  // one `eqIgnoreCase` branch per state name. Operators may configure state
  // names in any case in WORKFLOW.md.
  const varDecls = states.map((_, i) => `$s${i}: String!`).join(', ');
  const orClauses = states
    .map((_, i) => `{ state: { name: { eqIgnoreCase: $s${i} } } }`)
    .join(', ');
  const query = `
    query SymphonyIssuesByState(${varDecls}) {
      issues(filter: { or: [${orClauses}] }, first: 100) {
        nodes {
          ${ISSUE_FIELDS}
        }
      }
    }
  `;
  const vars = Object.fromEntries(states.map((s, i) => [`s${i}`, s]));
  try {
    const data = await client.request<{ issues: { nodes: LinearIssueNode[] } }>(query, vars);
    return data.issues.nodes.map(normalize);
  } catch (err) {
    throw classify(err);
  }
}

function byPriorityThenIdentifier(a: Issue, b: Issue): number {
  // Linear: 0 = none, 1 = urgent .. 4 = low. Spec says "ordered by priority"
  // (urgent first). Treat 0 (no priority) as the lowest.
  const pa = a.priority === 0 ? 99 : a.priority;
  const pb = b.priority === 0 ? 99 : b.priority;
  if (pa !== pb) return pa - pb;
  return a.identifier.localeCompare(b.identifier);
}

function classify(err: unknown): Error {
  // graphql-request throws ClientError with .response containing status + errors.
  const e = err as {
    response?: { status?: number; errors?: Array<{ message: string }> };
    message?: string;
  };
  const status = e.response?.status;
  if (status === 401 || status === 403) return new LinearAuthError(e.message ?? 'auth failed');
  if (status === 429) {
    const retry = Number(
      (
        e.response as { headers?: { get?: (k: string) => string | null } } | undefined
      )?.headers?.get?.('retry-after') ?? '5',
    );
    return new LinearRateLimitError(retry * 1000);
  }
  return err instanceof Error ? err : new Error(String(err));
}

// =========================================================================
// Normalization
// =========================================================================

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  branchName: string | null;
  state: { name: string } | null;
  labels: { nodes: Array<{ name: string }> } | null;
  relations: {
    nodes: Array<{
      type: string;
      relatedIssue: { identifier: string } | null;
    }>;
  } | null;
}

export function normalize(node: LinearIssueNode): Issue {
  if (!node.state?.name) {
    throw new Error(`Linear issue ${node.identifier} has no state`);
  }
  const blockers: string[] = [];
  for (const rel of node.relations?.nodes ?? []) {
    if (rel.type === 'blocked_by' && rel.relatedIssue) {
      blockers.push(rel.relatedIssue.identifier);
    }
  }
  return Issue.parse({
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description,
    priority: node.priority,
    state: node.state.name.toLowerCase(),
    branch: node.branchName,
    labels: (node.labels?.nodes ?? []).map((l) => l.name),
    blockers,
  });
}

// =========================================================================
// Queries
// =========================================================================

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  branchName
  state { name }
  labels { nodes { name } }
  relations {
    nodes {
      type
      relatedIssue { identifier }
    }
  }
`;

const VIEWER_QUERY = gql`
  query SymphonyPreflight {
    viewer { id }
  }
`;

const ISSUE_BY_ID_QUERY = gql`
  query SymphonyIssueById($id: String!) {
    issue(id: $id) {
      ${ISSUE_FIELDS}
    }
  }
`;
