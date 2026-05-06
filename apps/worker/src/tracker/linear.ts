import { Issue } from '@symphony/shared';
import { GraphQLClient, gql } from 'graphql-request';
import type { ResolvedConfig } from '../config/resolve.js';

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
  /**
   * Live config view. `endpoint`, `apiKey`, `activeStates`, and `terminalStates`
   * are read on every request so that SIGHUP-driven config swaps take effect
   * without rebuilding the client (see `apps/worker/src/config/reload.ts`).
   */
  config: ResolvedConfig;
  /**
   * Inject a custom client for tests. When provided, `config.trackerEndpoint()`
   * / `config.trackerApiKey()` are not used to build a real GraphQL client.
   */
  client?: GraphQLClient;
  /** Per-request abort timeout in ms. Default 15_000. */
  requestTimeoutMs?: number;
  /** Total attempts (initial + retries) for transient failures. Default 3. */
  maxAttempts?: number;
  /** Sleep injection for tests; defaults to setTimeout-based real sleep. */
  sleep?: (ms: number) => Promise<void>;
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
export class LinearTimeoutError extends Error {
  override readonly name = 'LinearTimeoutError';
  constructor(public readonly timeoutMs: number) {
    super(`Linear request timed out after ${timeoutMs}ms`);
  }
}

// =========================================================================
// Implementation
// =========================================================================

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 5_000;

interface ResilienceCtx {
  getClient: () => GraphQLClient;
  timeoutMs: number;
  maxAttempts: number;
  sleep: (ms: number) => Promise<void>;
}

export function createLinearClient(opts: LinearClientOptions): TrackerClient {
  // Memoize the underlying GraphQL client by (endpoint, apiKey) so a SIGHUP
  // reload that changes either field rebuilds the transport on the next
  // request, while unchanged config stays on the same instance.
  let cached: { key: string; client: GraphQLClient } | undefined;
  const getClient = (): GraphQLClient => {
    if (opts.client) return opts.client;
    const endpoint = opts.config.trackerEndpoint();
    const apiKey = opts.config.trackerApiKey();
    const key = `${endpoint}\n${apiKey}`;
    if (!cached || cached.key !== key) {
      cached = {
        key,
        client: new GraphQLClient(endpoint, { headers: { authorization: apiKey } }),
      };
    }
    return cached.client;
  };

  const ctx: ResilienceCtx = {
    getClient,
    timeoutMs: opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxAttempts: Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    sleep: opts.sleep ?? defaultSleep,
  };

  // Read the prefix at call time (not capture time) so a SIGHUP-driven config
  // swap takes effect on the next fetch, matching how states/endpoint are read.
  // The prefix becomes a server-side `team.key` filter on the GraphQL query so
  // the `first: 100` page can't be filled by off-team issues that get dropped
  // locally — without this, a busy shared workspace silently starves the
  // configured team. The client-side check below is defense-in-depth in case
  // the prefix doesn't follow the standard `<TEAMKEY>-` shape.
  const teamKeyFromPrefix = (): string | null => {
    const prefix = opts.config.identifierPrefix();
    if (!prefix || !prefix.endsWith('-')) return null;
    return prefix.slice(0, -1);
  };
  const filterByPrefix = (issues: Issue[]): Issue[] => {
    const prefix = opts.config.identifierPrefix();
    return prefix ? issues.filter((i) => i.identifier.startsWith(prefix)) : issues;
  };

  return {
    async preflight() {
      await execute<{ viewer: { id: string } }>(ctx, VIEWER_QUERY, undefined);
    },

    async fetchActive() {
      const issues = await fetchByStateNames(
        ctx,
        opts.config.activeStates(),
        teamKeyFromPrefix(),
        opts.config.projectId(),
      );
      return filterByPrefix(issues).sort(byPriorityThenIdentifier);
    },

    async fetchTerminal() {
      const issues = await fetchByStateNames(
        ctx,
        opts.config.terminalStates(),
        teamKeyFromPrefix(),
        opts.config.projectId(),
      );
      return filterByPrefix(issues);
    },

    async fetchById(id: string) {
      // Linear reports an unknown id as a GraphQL `INPUT_ERROR` (HTTP 200 with
      // an `errors` array) rather than `{ issue: null }`. Map that shape to
      // null so callers like `confirmNotActive` can clear stale state.
      try {
        const data = await execute<{ issue: LinearIssueNode | null }>(ctx, ISSUE_BY_ID_QUERY, {
          id,
        });
        if (!data.issue) return null;
        const projectId = opts.config.projectId();
        if (projectId && data.issue.project?.id !== projectId) return null;
        const issue = normalize(data.issue);
        const prefix = opts.config.identifierPrefix();
        if (prefix && !issue.identifier.startsWith(prefix)) return null;
        return issue;
      } catch (err) {
        if (isEntityNotFoundError(err)) return null;
        throw err;
      }
    },
  };
}

async function fetchByStateNames(
  ctx: ResilienceCtx,
  states: string[],
  teamKey: string | null,
  projectId: string | null,
): Promise<Issue[]> {
  if (states.length === 0) return [];
  // Linear's StringComparator doesn't support `inIgnoreCase`, so we OR together
  // one `eqIgnoreCase` branch per state name. Operators may configure state
  // names in any case in WORKFLOW.md.
  const varDecls = states.map((_, i) => `$s${i}: String!`);
  const orClauses = states
    .map((_, i) => `{ state: { name: { eqIgnoreCase: $s${i} } } }`)
    .join(', ');
  // Bind the team-key and project-id restrictions inside the same filter so
  // they intersect with the state OR-list — `first: 100` then applies to
  // in-scope issues only. Same starvation-prevention rationale as the team
  // filter (a busy shared workspace would otherwise fill the page with
  // off-project issues that we'd drop locally).
  const filterParts = [`or: [${orClauses}]`];
  if (teamKey !== null) {
    varDecls.push('$teamKey: String!');
    filterParts.push('team: { key: { eq: $teamKey } }');
  }
  if (projectId !== null) {
    varDecls.push('$projectId: ID!');
    filterParts.push('project: { id: { eq: $projectId } }');
  }
  const query = `
    query SymphonyIssuesByState(${varDecls.join(', ')}) {
      issues(filter: { ${filterParts.join(', ')} }, first: 100) {
        nodes {
          ${ISSUE_FIELDS}
        }
      }
    }
  `;
  const vars: Record<string, string> = Object.fromEntries(states.map((s, i) => [`s${i}`, s]));
  if (teamKey !== null) vars.teamKey = teamKey;
  if (projectId !== null) vars.projectId = projectId;
  const data = await execute<{ issues: { nodes: LinearIssueNode[] } }>(ctx, query, vars);
  return data.issues.nodes.map(normalize);
}

function byPriorityThenIdentifier(a: Issue, b: Issue): number {
  // Linear: 0 = none, 1 = urgent .. 4 = low. Spec says "ordered by priority"
  // (urgent first). Treat 0 (no priority) as the lowest.
  const pa = a.priority === 0 ? 99 : a.priority;
  const pb = b.priority === 0 ? 99 : b.priority;
  if (pa !== pb) return pa - pb;
  return a.identifier.localeCompare(b.identifier);
}

// =========================================================================
// Resilience: per-request timeout + retry on 429 / 5xx / network / timeout
// =========================================================================

type Attempt<T> = { ok: true; value: T } | { ok: false; err: unknown };

async function execute<T>(
  ctx: ResilienceCtx,
  document: string,
  variables: Record<string, unknown> | undefined,
): Promise<T> {
  let lastErr: unknown = new Error('linear: no attempts made');
  for (let attempt = 1; attempt <= ctx.maxAttempts; attempt++) {
    const outcome = await tryOnce<T>(ctx, document, variables);
    if (outcome.ok) return outcome.value;
    lastErr = outcome.err;

    const decision = classifyForRetry(outcome.err, ctx.timeoutMs);
    const isLast = attempt === ctx.maxAttempts;
    if (decision.kind === 'fatal' || isLast) throw decision.error;

    await ctx.sleep(retryDelay(decision, attempt));
  }
  // Loop bound guarantees this is unreachable, but keep the throw for type safety.
  throw classify(lastErr, ctx.timeoutMs);
}

async function tryOnce<T>(
  ctx: ResilienceCtx,
  document: string,
  variables: Record<string, unknown> | undefined,
): Promise<Attempt<T>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ctx.timeoutMs);
  try {
    const value = await ctx.getClient().request<T>({
      document,
      variables: variables as Record<string, unknown>,
      signal: ac.signal,
    });
    return { ok: true, value };
  } catch (err) {
    return { ok: false, err };
  } finally {
    clearTimeout(timer);
  }
}

type RetryDecision =
  | { kind: 'fatal'; error: Error }
  | { kind: 'rate-limit'; retryAfterMs: number; error: LinearRateLimitError }
  | { kind: 'transient'; error: Error };

function classifyForRetry(err: unknown, timeoutMs: number): RetryDecision {
  if (isAbortError(err)) {
    return { kind: 'transient', error: new LinearTimeoutError(timeoutMs) };
  }
  const status = readStatus(err);
  if (status === 401 || status === 403) {
    const msg = (err as { message?: string }).message ?? 'auth failed';
    return { kind: 'fatal', error: new LinearAuthError(msg) };
  }
  if (status === 429) {
    const ms = readRetryAfterMs(err);
    return { kind: 'rate-limit', retryAfterMs: ms, error: new LinearRateLimitError(ms) };
  }
  if (status === undefined || (status >= 500 && status < 600)) {
    return { kind: 'transient', error: err instanceof Error ? err : new Error(String(err)) };
  }
  return { kind: 'fatal', error: err instanceof Error ? err : new Error(String(err)) };
}

function classify(err: unknown, timeoutMs: number): Error {
  return classifyForRetry(err, timeoutMs).error;
}

function retryDelay(decision: RetryDecision, attempt: number): number {
  if (decision.kind === 'rate-limit') {
    // Honour Retry-After exactly, plus small additive jitter (0–250 ms) so a
    // herd of workers don't all wake at the same instant.
    return decision.retryAfterMs + Math.random() * 250;
  }
  // Exponential backoff: base * 2^(attempt-1), capped, with up to +50% multiplicative jitter.
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
  return Math.min(exp + Math.random() * exp * 0.5, BACKOFF_CAP_MS);
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: string };
  return e.name === 'AbortError' || e.code === 'ABORT_ERR';
}

function readStatus(err: unknown): number | undefined {
  const e = err as { response?: { status?: number } } | null | undefined;
  return e?.response?.status;
}

function isEntityNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const errors = (
    err as {
      response?: {
        errors?: Array<{ message?: string; extensions?: { code?: string } }>;
      };
    }
  ).response?.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some(
    (e) =>
      e?.extensions?.code === 'INPUT_ERROR' &&
      typeof e.message === 'string' &&
      e.message.startsWith('Entity not found'),
  );
}

function readRetryAfterMs(err: unknown): number {
  const e = err as
    | { response?: { headers?: Headers | { get?: (k: string) => string | null } } }
    | null
    | undefined;
  const hdrs = e?.response?.headers;
  let raw: string | null = null;
  if (hdrs && typeof (hdrs as { get?: unknown }).get === 'function') {
    raw = (hdrs as { get: (k: string) => string | null }).get('retry-after') ?? null;
  }
  if (raw === null) return 5_000;

  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n * 1000;

  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());

  return 5_000;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
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
  // Only used by `fetchById` for project-scope defense-in-depth; not surfaced
  // on the normalized `Issue` type. Optional so test fixtures (and pre-SYM-34
  // shapes) without the field still type-check.
  project?: { id: string } | null;
  labels: { nodes: Array<{ name: string }> } | null;
  // Linear models "X is blocked by Y" as a single IssueRelation row owned by Y
  // with type='blocks' pointing at X. From X's side it's reachable via
  // `inverseRelations`, where `issue` is the source (the blocker) and
  // `relatedIssue` would point back at X. There is no 'blocked_by' type — that
  // direction is always implicit in inverseRelations.
  inverseRelations: {
    nodes: Array<{
      type: string;
      issue: {
        identifier: string;
        state: { type: string } | null;
      } | null;
    }>;
  } | null;
  attachments: { nodes: Array<{ url: string }> } | null;
}

// Match URL pattern rather than Linear's `sourceType` field — `sourceType` is
// integration-dependent and not always populated, but the URL shape is stable.
const GITHUB_PR_URL_RE = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#].*)?$/;

// Linear `state.type` values for issues that no longer gate dependents.
// Anything else (`triage`/`backlog`/`unstarted`/`started`) is still open.
const TERMINAL_STATE_TYPES = new Set(['completed', 'canceled']);

export function normalize(node: LinearIssueNode): Issue {
  if (!node.state?.name) {
    throw new Error(`Linear issue ${node.identifier} has no state`);
  }
  const blockers: string[] = [];
  for (const rel of node.inverseRelations?.nodes ?? []) {
    if (rel.type !== 'blocks' || !rel.issue) continue;
    const stateType = rel.issue.state?.type;
    if (stateType && TERMINAL_STATE_TYPES.has(stateType)) continue;
    blockers.push(rel.issue.identifier);
  }
  const prUrls = Array.from(
    new Set(
      (node.attachments?.nodes ?? []).map((a) => a.url).filter((u) => GITHUB_PR_URL_RE.test(u)),
    ),
  );
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
    pr_urls: prUrls,
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
  project { id }
  labels { nodes { name } }
  inverseRelations {
    nodes {
      type
      issue {
        identifier
        state { type }
      }
    }
  }
  attachments { nodes { url } }
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
