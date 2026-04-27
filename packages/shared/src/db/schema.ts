import { sql } from 'drizzle-orm';
import {
  bigserial,
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  pgView,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

// =========================================================================
// Enums
// =========================================================================

export const runStatusEnum = pgEnum('run_status', [
  'pending',
  'running',
  'success',
  'failure',
  'timeout',
  'cancelled',
]);

export const agentEventKindEnum = pgEnum('agent_event_kind', [
  'status',
  'tool_call',
  'approval',
  'token_count',
  'error',
  'user_input',
  'humanized',
  'rate_limit',
]);

export const hookNameEnum = pgEnum('hook_name', [
  'after_create',
  'before_run',
  'after_run',
  'before_remove',
]);

// =========================================================================
// workflows
// =========================================================================

export const workflows = pgTable(
  'workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source_hash: text('source_hash').notNull().unique(),
    parsed: jsonb('parsed').$type<Json>().notNull(),
    prompt_template: text('prompt_template').notNull(),
    loaded_at: tstz('loaded_at').notNull().defaultNow(),
  },
  (t) => ({
    loadedAtIdx: index('workflows_loaded_at_idx').on(sql`${t.loaded_at} desc`),
  }),
);

// =========================================================================
// issues
// =========================================================================

export const issues = pgTable(
  'issues',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull().unique(),
    title: text('title').notNull(),
    description: text('description'),
    priority: smallint('priority').notNull().default(0),
    state: text('state').notNull(),
    branch: text('branch'),
    labels: text('labels').array().notNull().default(sql`'{}'`),
    blockers: text('blockers').array().notNull().default(sql`'{}'`),
    pr_urls: text('pr_urls').array().notNull().default(sql`'{}'`),
    raw: jsonb('raw').$type<Json>().notNull(),
    last_seen_at: tstz('last_seen_at').notNull().defaultNow(),
  },
  (t) => ({
    stateIdx: index('issues_state_idx').on(t.state),
    priorityIdx: index('issues_priority_idx').on(sql`${t.priority} desc`),
  }),
);

// =========================================================================
// runs
// =========================================================================

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issue_id: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    run_number: integer('run_number').notNull(),
    workspace_path: text('workspace_path').notNull(),
    status: runStatusEnum('status').notNull().default('pending'),
    started_at: tstz('started_at'),
    ended_at: tstz('ended_at'),
    error_class: text('error_class'),
    error_message: text('error_message'),
    worker_pid: integer('worker_pid'),
    created_at: tstz('created_at').notNull().defaultNow(),
  },
  (t) => ({
    issueRunUnique: uniqueIndex('runs_issue_id_run_number_key').on(t.issue_id, t.run_number),
  }),
);

// =========================================================================
// live_sessions
// =========================================================================

export const liveSessions = pgTable('live_sessions', {
  run_id: uuid('run_id')
    .primaryKey()
    .references(() => runs.id, { onDelete: 'cascade' }),
  session_id: text('session_id').notNull(),
  thread_id: text('thread_id').notNull(),
  turn_id: text('turn_id').notNull(),
  input_tokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
  output_tokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
  total_tokens: bigint('total_tokens', { mode: 'number' }).notNull().default(0),
  last_event_at: tstz('last_event_at').notNull().defaultNow(),
  started_at: tstz('started_at').notNull().defaultNow(),
});

// =========================================================================
// agent_events
// =========================================================================

export const agentEvents = pgTable('agent_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  run_id: uuid('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  kind: agentEventKindEnum('kind').notNull(),
  payload: jsonb('payload').$type<Json>().notNull(),
  created_at: tstz('created_at').notNull().defaultNow(),
});

// =========================================================================
// agent_events_latest (view)
// =========================================================================

export const agentEventsLatest = pgView('agent_events_latest', {
  id: bigint('id', { mode: 'number' }),
  run_id: uuid('run_id'),
  kind: agentEventKindEnum('kind'),
  payload: jsonb('payload').$type<Json>(),
  created_at: tstz('created_at'),
}).existing();

// =========================================================================
// retry_queue
// =========================================================================

export const retryQueue = pgTable('retry_queue', {
  issue_id: text('issue_id')
    .primaryKey()
    .references(() => issues.id, { onDelete: 'cascade' }),
  run_number: integer('run_number').notNull(),
  due_at: tstz('due_at').notNull(),
  error_class: text('error_class'),
  error_message: text('error_message'),
  created_at: tstz('created_at').notNull().defaultNow(),
});

// =========================================================================
// hook_runs
// =========================================================================

export const hookRuns = pgTable('hook_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  run_id: uuid('run_id').references(() => runs.id, { onDelete: 'cascade' }),
  hook: hookNameEnum('hook').notNull(),
  exit_code: integer('exit_code').notNull(),
  duration_ms: integer('duration_ms').notNull(),
  stderr_tail: text('stderr_tail'),
  created_at: tstz('created_at').notNull().defaultNow(),
});

// =========================================================================
// rate_limit_state
// =========================================================================

export const rateLimitState = pgTable('rate_limit_state', {
  source: text('source').primaryKey(),
  remaining: bigint('remaining', { mode: 'number' }),
  reset_at: tstz('reset_at'),
  updated_at: tstz('updated_at').notNull().defaultNow(),
});

// =========================================================================
// worker_heartbeat
// =========================================================================

export const workerHeartbeat = pgTable('worker_heartbeat', {
  id: text('id').primaryKey().default('worker'),
  started_at: tstz('started_at').notNull(),
  last_beat_at: tstz('last_beat_at').notNull().defaultNow(),
  worker_pid: integer('worker_pid'),
});

// =========================================================================
// Schema map for the Tables<>/TablesInsert<> shim
// =========================================================================

export const schema = {
  workflows,
  issues,
  runs,
  live_sessions: liveSessions,
  agent_events: agentEvents,
  agent_events_latest: agentEventsLatest,
  retry_queue: retryQueue,
  hook_runs: hookRuns,
  rate_limit_state: rateLimitState,
  worker_heartbeat: workerHeartbeat,
} as const;

export type SchemaMap = typeof schema;
