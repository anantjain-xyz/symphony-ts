import { z } from 'zod';

// =========================================================================
// Workflow (parsed WORKFLOW.md front matter)
// =========================================================================

export const TrackerConfig = z
  .object({
    kind: z.literal('linear'),
    endpoint: z.string().url().default('https://api.linear.app/graphql'),
    api_key: z.string().min(1),
    project_slug: z.string().optional(),
    active_states: z.array(z.string()).min(1),
    terminal_states: z.array(z.string()).min(1),
  })
  .strict();
export type TrackerConfig = z.infer<typeof TrackerConfig>;

export const PollingConfig = z
  .object({
    interval_ms: z.number().int().positive().default(30_000),
  })
  .strict()
  .default({ interval_ms: 30_000 });
export type PollingConfig = z.infer<typeof PollingConfig>;

export const WorkspaceConfig = z
  .object({
    root: z.string().default('${TMPDIR}/symphony-workspaces'),
  })
  .strict()
  .default({ root: '${TMPDIR}/symphony-workspaces' });
export type WorkspaceConfig = z.infer<typeof WorkspaceConfig>;

export const HooksConfig = z
  .object({
    after_create: z.string().optional(),
    before_run: z.string().optional(),
    after_run: z.string().optional(),
    before_remove: z.string().optional(),
    timeout_ms: z.number().int().positive().default(60_000),
  })
  .strict()
  .default({ timeout_ms: 60_000 });
export type HooksConfig = z.infer<typeof HooksConfig>;

export const AgentBackend = z.enum(['codex', 'claude']);
export type AgentBackend = z.infer<typeof AgentBackend>;

export const AgentConfig = z
  .object({
    backend: AgentBackend.default('codex'),
    max_concurrent_agents: z.number().int().positive().default(10),
    max_retry_backoff_ms: z.number().int().positive().default(300_000),
    max_concurrent_agents_by_state: z.record(z.string(), z.number().int().positive()).default({}),
  })
  .strict()
  .default({
    backend: 'codex',
    max_concurrent_agents: 10,
    max_retry_backoff_ms: 300_000,
    max_concurrent_agents_by_state: {},
  });
export type AgentConfig = z.infer<typeof AgentConfig>;

export const CodexConfig = z
  .object({
    command: z.string().default('codex'),
    approval_policy: z.enum(['never', 'on-request', 'on-failure', 'always']).default('never'),
    thread_sandbox: z.enum(['none', 'workspace-write', 'read-only']).default('workspace-write'),
    turn_sandbox_policy: z
      .enum(['inherit', 'workspace-write', 'read-only', 'danger-full-access'])
      .default('inherit'),
    turn_timeout_ms: z.number().int().positive().default(3_600_000),
    // Codex 0.120.0 gates outbound network as a single blanket toggle under
    // the workspace-write sandbox mode; no per-host allowlist is available.
    // Default off preserves the stricter sandbox for repos that don't need it.
    network_access: z.boolean().default(false),
  })
  .strict()
  .default({
    command: 'codex',
    approval_policy: 'never',
    thread_sandbox: 'workspace-write',
    turn_sandbox_policy: 'inherit',
    turn_timeout_ms: 3_600_000,
    network_access: false,
  });
export type CodexConfig = z.infer<typeof CodexConfig>;

export const ClaudePermissionMode = z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']);
export type ClaudePermissionMode = z.infer<typeof ClaudePermissionMode>;

export const ClaudeConfig = z
  .object({
    // Default targets the bundled adapter (resolved via the env var the worker
    // populates in index.ts) so flipping `agent.backend: claude` works without
    // the user having to wire up a `command:` line. The adapter speaks our
    // JSON-RPC protocol; the raw `claude` CLI does not, so don't use that.
    command: z.string().default('node ${SYMPHONY_CLAUDE_ADAPTER}'),
    permission_mode: ClaudePermissionMode.default('acceptEdits'),
    allowed_tools: z.array(z.string()).default([]),
    disallowed_tools: z.array(z.string()).default([]),
    add_dirs: z.array(z.string()).default([]),
    turn_timeout_ms: z.number().int().positive().default(3_600_000),
  })
  .strict()
  .default({
    command: 'node ${SYMPHONY_CLAUDE_ADAPTER}',
    permission_mode: 'acceptEdits',
    allowed_tools: [],
    disallowed_tools: [],
    add_dirs: [],
    turn_timeout_ms: 3_600_000,
  });
export type ClaudeConfig = z.infer<typeof ClaudeConfig>;

/**
 * Top-level WORKFLOW.md front matter. Unknown keys are tolerated for forward
 * compatibility (spec: "Unknown keys ignored").
 */
export const WorkflowFrontMatter = z
  .object({
    tracker: TrackerConfig,
    polling: PollingConfig,
    workspace: WorkspaceConfig,
    hooks: HooksConfig,
    agent: AgentConfig,
    codex: CodexConfig,
    claude: ClaudeConfig,
  })
  .passthrough();
export type WorkflowFrontMatter = z.infer<typeof WorkflowFrontMatter>;

export interface ParsedWorkflow {
  frontMatter: WorkflowFrontMatter;
  promptTemplate: string;
  sourceHash: string;
}

// =========================================================================
// Issue (normalized tracker payload)
// =========================================================================

export const IssuePriority = z.number().int().min(0).max(4); // Linear: 0=none .. 4=urgent

export const Issue = z
  .object({
    id: z.string().min(1),
    identifier: z.string().min(1),
    title: z.string(),
    description: z.string().nullable(),
    priority: IssuePriority,
    state: z.string().min(1), // lowercased state name
    branch: z.string().nullable(),
    labels: z.array(z.string()),
    blockers: z.array(z.string()),
  })
  .strict();
export type Issue = z.infer<typeof Issue>;

// =========================================================================
// Run attempt + sessions + events (mirrors Supabase enums)
// =========================================================================

export const RunAttemptStatus = z.enum([
  'pending',
  'running',
  'success',
  'failure',
  'timeout',
  'cancelled',
]);
export type RunAttemptStatus = z.infer<typeof RunAttemptStatus>;

export const AgentEventKind = z.enum([
  'status',
  'tool_call',
  'approval',
  'token_count',
  'error',
  'user_input',
  'humanized',
]);
export type AgentEventKind = z.infer<typeof AgentEventKind>;

export const HookName = z.enum(['after_create', 'before_run', 'after_run', 'before_remove']);
export type HookName = z.infer<typeof HookName>;

// Payload shapes for AgentEvent.payload (jsonb). Discriminated by `kind` in the row.
export const StatusPayload = z.object({ message: z.string() });
export const ToolCallPayload = z.object({
  tool: z.string(),
  args: z.unknown().optional(),
  call_id: z.string().optional(),
  result_summary: z.string().optional(),
});
export const ApprovalPayload = z.object({
  reason: z.string(),
  call_id: z.string().optional(),
});
export const TokenCountPayload = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});
export const ErrorPayload = z.object({
  class: z.string(),
  message: z.string(),
  recoverable: z.boolean().optional(),
});
export const UserInputPayload = z.object({ text: z.string() });
export const HumanizedPayload = z.object({ summary: z.string() });

// =========================================================================
// Retry entry
// =========================================================================

export const RetryEntry = z
  .object({
    issue_id: z.string(),
    attempt_number: z.number().int().positive(),
    due_at_ms: z.number().int().nonnegative(),
    error_class: z.string().nullable(),
    error_message: z.string().nullable(),
  })
  .strict();
export type RetryEntry = z.infer<typeof RetryEntry>;

// =========================================================================
// Live session (orchestrator runtime view of an in-flight session)
// =========================================================================

export const LiveSession = z
  .object({
    run_attempt_id: z.string().uuid(),
    session_id: z.string(),
    thread_id: z.string(),
    turn_id: z.string(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
    last_event_at_ms: z.number().int().nonnegative(),
  })
  .strict();
export type LiveSession = z.infer<typeof LiveSession>;
