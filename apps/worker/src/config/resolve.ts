import type {
  AgentBackend,
  ClaudeConfig,
  Issue,
  ParsedRepos,
  ParsedWorkflow,
  RepoEntry,
} from '@symphony/shared';
import { resolveRepoForIssue as matchRepo } from './repos.js';

/**
 * Typed view over a parsed workflow with explicit overrides applied on top.
 *
 * Spec precedence: explicit application setting > WORKFLOW.md > env var > default.
 * Env vars are folded in during workflow parsing (`${VAR}` interpolation), and
 * defaults are applied by zod. This layer adds the optional explicit overrides
 * and gives the orchestrator a single object to pass around.
 */
export interface ResolvedConfig {
  pollIntervalMs(): number;
  maxConcurrentAgents(): number;
  maxConcurrentByState(): Record<string, number>;
  maxRetryBackoffMs(): number;
  hookTimeoutMs(): number;
  workspaceRoot(): string;
  trackerEndpoint(): string;
  trackerApiKey(): string;
  activeStates(): string[];
  terminalStates(): string[];
  /** Optional identifier prefix (e.g. "PB-"). When set, the tracker drops issues whose identifier doesn't start with it. */
  identifierPrefix(): string | null;
  /**
   * Linear project UUIDs the tracker is restricted to. Empty array = no
   * project filter (worker sees every issue allowed by the team / prefix
   * filters). Accepts a single UUID, a CSV string, or a YAML array in
   * WORKFLOW.md — see `TrackerConfig.project_id`.
   */
  projectIds(): string[];
  /** Selected agent backend (workflow default; repos may override per-issue). */
  agentBackend(): AgentBackend;
  /** Command to spawn for the selected backend's adapter. */
  agentCommand(): string;
  codexCommand(): string;
  claudeCommand(): string;
  /** Turn timeout for the selected backend. */
  turnTimeoutMs(): number;
  /** Per-backend turn timeout, used when a repo overrides the workflow backend. */
  turnTimeoutMsForBackend(backend: AgentBackend): number;
  /** Per-backend adapter command, used when a repo overrides the workflow backend. */
  agentCommandForBackend(backend: AgentBackend): string;
  /** Full claude block (used by dispatch to build adapter flags). */
  claude(): ClaudeConfig;
  promptTemplate(): string;
  sourceHash(): string;
  /** Stable hash over the repos.md source. */
  reposHash(): string;
  /** Parsed repos.md (always present — repos.md is required at startup). */
  repos(): ParsedRepos;
  /**
   * Resolve the target repo for an issue. Returns null when no `repo:*` label
   * on the issue matches a configured entry; the orchestrator treats null as
   * "ineligible, skip silently".
   */
  resolveRepoForIssue(issue: Issue): RepoEntry | null;
  workflow(): ParsedWorkflow;
  /**
   * Frozen view of the current config — captured at call time. Static configs
   * return themselves; live configs (see `liveConfig`) return their inner
   * `ResolvedConfig` so future swaps don't affect the captured snapshot.
   */
  snapshot(): ResolvedConfig;
}

/**
 * Atomic, swappable wrapper around a `ResolvedConfig`. The orchestrator loop
 * reads it on each tick (so SIGHUP reloads take effect on the next dispatch),
 * while in-flight attempts hold a `snapshot()` so they keep their original
 * config across a swap.
 */
export interface LiveResolvedConfig extends ResolvedConfig {
  /**
   * Replace the inner `ResolvedConfig`. Subsequent reads through this wrapper
   * see the new values; previously-captured `snapshot()` results do not.
   */
  swap(next: ResolvedConfig): void;
}

export interface ConfigOverrides {
  pollIntervalMs?: number;
  maxConcurrentAgents?: number;
  hookTimeoutMs?: number;
}

export function resolveConfig(
  workflow: ParsedWorkflow,
  overrides: ConfigOverrides,
  repos: ParsedRepos,
): ResolvedConfig {
  const commandForBackend = (backend: AgentBackend): string =>
    backend === 'claude' ? workflow.frontMatter.claude.command : workflow.frontMatter.codex.command;
  const timeoutForBackend = (backend: AgentBackend): number =>
    backend === 'claude'
      ? workflow.frontMatter.claude.turn_timeout_ms
      : workflow.frontMatter.codex.turn_timeout_ms;

  const rc: ResolvedConfig = {
    pollIntervalMs: () => overrides.pollIntervalMs ?? workflow.frontMatter.polling.interval_ms,
    maxConcurrentAgents: () =>
      overrides.maxConcurrentAgents ?? workflow.frontMatter.agent.max_concurrent_agents,
    maxConcurrentByState: () => workflow.frontMatter.agent.max_concurrent_agents_by_state,
    maxRetryBackoffMs: () => workflow.frontMatter.agent.max_retry_backoff_ms,
    hookTimeoutMs: () => overrides.hookTimeoutMs ?? workflow.frontMatter.hooks.timeout_ms,
    workspaceRoot: () => workflow.frontMatter.workspace.root,
    trackerEndpoint: () => workflow.frontMatter.tracker.endpoint,
    trackerApiKey: () => workflow.frontMatter.tracker.api_key,
    activeStates: () => workflow.frontMatter.tracker.active_states.map((s) => s.toLowerCase()),
    terminalStates: () => workflow.frontMatter.tracker.terminal_states.map((s) => s.toLowerCase()),
    identifierPrefix: () => workflow.frontMatter.tracker.identifier_prefix ?? null,
    projectIds: () => workflow.frontMatter.tracker.project_id ?? [],
    agentBackend: () => workflow.frontMatter.agent.backend,
    agentCommand: () => commandForBackend(workflow.frontMatter.agent.backend),
    codexCommand: () => workflow.frontMatter.codex.command,
    claudeCommand: () => workflow.frontMatter.claude.command,
    turnTimeoutMs: () => timeoutForBackend(workflow.frontMatter.agent.backend),
    turnTimeoutMsForBackend: timeoutForBackend,
    agentCommandForBackend: commandForBackend,
    claude: () => workflow.frontMatter.claude,
    promptTemplate: () => workflow.promptTemplate,
    sourceHash: () => workflow.sourceHash,
    reposHash: () => repos.sourceHash,
    repos: () => repos,
    resolveRepoForIssue: (issue) => matchRepo(repos, issue),
    workflow: () => workflow,
    snapshot: () => rc,
  };
  return rc;
}

/**
 * Wrap a `ResolvedConfig` so it can be hot-swapped (e.g. on SIGHUP). All
 * delegating reads see the current inner config; `snapshot()` returns the
 * inner ResolvedConfig at call time, which is itself static and survives
 * future swaps unchanged. This is the contract dispatch relies on so an
 * in-flight attempt finishes under the config it started with.
 *
 * Implemented as a `Proxy` so new `ResolvedConfig` methods are forwarded
 * automatically — there's no parallel list of forwarders to keep in sync.
 */
export function liveConfig(initial: ResolvedConfig): LiveResolvedConfig {
  let current = initial;
  const swap = (next: ResolvedConfig) => {
    current = next;
  };
  const snapshot = () => current;
  return new Proxy({} as LiveResolvedConfig, {
    get(_target, prop) {
      if (prop === 'swap') return swap;
      if (prop === 'snapshot') return snapshot;
      const value = (current as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof value === 'function' ? value.bind(current) : value;
    },
  });
}
