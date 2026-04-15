import type { ParsedWorkflow } from '@symphony/shared';

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
  codexCommand(): string;
  turnTimeoutMs(): number;
  promptTemplate(): string;
  sourceHash(): string;
  workflow(): ParsedWorkflow;
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
  return {
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
    codexCommand: () => workflow.frontMatter.codex.command,
    turnTimeoutMs: () => workflow.frontMatter.codex.turn_timeout_ms,
    promptTemplate: () => workflow.promptTemplate,
    sourceHash: () => workflow.sourceHash,
    workflow: () => workflow,
  };
}
