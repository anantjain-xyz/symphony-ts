import type { AgentBackend, ClaudeConfig, ParsedWorkflow } from '@symphony/shared';

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
  /** Optional Linear project UUID. When set, the tracker only fetches issues belonging to this project. */
  projectId(): string | null;
  /** Selected agent backend. */
  agentBackend(): AgentBackend;
  /** Command to spawn for the selected backend's adapter. */
  agentCommand(): string;
  codexCommand(): string;
  claudeCommand(): string;
  /** Turn timeout for the selected backend. */
  turnTimeoutMs(): number;
  /**
   * Pause new dispatches when the active backend's remaining quota drops below
   * this %. 0 disables the gate (no probing happens at all).
   */
  minRemainingUsagePct(): number;
  /** Full claude block (used by dispatch to build adapter flags). */
  claude(): ClaudeConfig;
  promptTemplate(): string;
  sourceHash(): string;
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
  overrides: ConfigOverrides = {},
): ResolvedConfig {
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
    projectId: () => workflow.frontMatter.tracker.project_id ?? null,
    agentBackend: () => workflow.frontMatter.agent.backend,
    agentCommand: () =>
      workflow.frontMatter.agent.backend === 'claude'
        ? workflow.frontMatter.claude.command
        : workflow.frontMatter.codex.command,
    codexCommand: () => workflow.frontMatter.codex.command,
    claudeCommand: () => workflow.frontMatter.claude.command,
    turnTimeoutMs: () =>
      workflow.frontMatter.agent.backend === 'claude'
        ? workflow.frontMatter.claude.turn_timeout_ms
        : workflow.frontMatter.codex.turn_timeout_ms,
    minRemainingUsagePct: () => workflow.frontMatter.agent.min_remaining_usage_pct,
    claude: () => workflow.frontMatter.claude,
    promptTemplate: () => workflow.promptTemplate,
    sourceHash: () => workflow.sourceHash,
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
 */
export function liveConfig(initial: ResolvedConfig): LiveResolvedConfig {
  let current = initial;
  return {
    pollIntervalMs: () => current.pollIntervalMs(),
    maxConcurrentAgents: () => current.maxConcurrentAgents(),
    maxConcurrentByState: () => current.maxConcurrentByState(),
    maxRetryBackoffMs: () => current.maxRetryBackoffMs(),
    hookTimeoutMs: () => current.hookTimeoutMs(),
    workspaceRoot: () => current.workspaceRoot(),
    trackerEndpoint: () => current.trackerEndpoint(),
    trackerApiKey: () => current.trackerApiKey(),
    activeStates: () => current.activeStates(),
    terminalStates: () => current.terminalStates(),
    identifierPrefix: () => current.identifierPrefix(),
    projectId: () => current.projectId(),
    agentBackend: () => current.agentBackend(),
    agentCommand: () => current.agentCommand(),
    codexCommand: () => current.codexCommand(),
    claudeCommand: () => current.claudeCommand(),
    turnTimeoutMs: () => current.turnTimeoutMs(),
    minRemainingUsagePct: () => current.minRemainingUsagePct(),
    claude: () => current.claude(),
    promptTemplate: () => current.promptTemplate(),
    sourceHash: () => current.sourceHash(),
    workflow: () => current.workflow(),
    snapshot: () => current,
    swap: (next) => {
      current = next;
    },
  };
}
