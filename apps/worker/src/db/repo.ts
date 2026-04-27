import {
  agentEvents,
  agentEventsLatest as _agentEventsLatest,
  type AgentEventKind,
  type Db,
  hookRuns,
  type HookName,
  type Issue,
  issues,
  liveSessions,
  type ParsedWorkflow,
  rateLimitState,
  retryQueue,
  type RunStatus,
  runs,
  type Tables,
  type TablesInsert,
  workerHeartbeat,
  workflows,
} from '@symphony/shared';
import { and, desc, eq, gt, inArray, like, lt, sql } from 'drizzle-orm';

export class AlreadyRunningError extends Error {
  constructor(public readonly runId: string) {
    super(`another run for the same issue is already running (lost race for ${runId})`);
    this.name = 'AlreadyRunningError';
  }
}

export type RunRow = Tables<'runs'>;
export type IssueRow = Tables<'issues'>;
export type WorkflowRow = Tables<'workflows'>;
export type LiveSessionRow = Tables<'live_sessions'>;
export type AgentEventRow = Tables<'agent_events'>;
export type RetryQueueRow = Tables<'retry_queue'>;
export type RateLimitStateRow = Tables<'rate_limit_state'>;

const TERMINAL_RUN_STATUSES = ['success', 'failure', 'timeout', 'cancelled'] as const;

function isUniqueViolation(err: unknown): boolean {
  // postgres-js raises errors with `code: '23505'`; Drizzle wraps them so
  // the original sits on `.cause`. Walk the chain.
  let cur: unknown = err;
  while (cur && typeof cur === 'object') {
    if ((cur as { code?: string }).code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Typed CRUD over the symphony Postgres. The worker connects with the database
 * owner role, so it has full read/write access; auth is enforced solely by
 * possession of `DATABASE_URL`.
 */
export class Repo {
  constructor(private readonly db: Db) {}

  // ---- workflows ----
  async upsertWorkflow(workflow: ParsedWorkflow): Promise<void> {
    const row: TablesInsert<'workflows'> = {
      source_hash: workflow.sourceHash,
      parsed: workflow.frontMatter as unknown as TablesInsert<'workflows'>['parsed'],
      prompt_template: workflow.promptTemplate,
    };
    await this.db
      .insert(workflows)
      .values(row)
      .onConflictDoNothing({ target: workflows.source_hash });
  }

  async latestWorkflow(): Promise<WorkflowRow | null> {
    const [row] = await this.db
      .select()
      .from(workflows)
      .orderBy(desc(workflows.loaded_at))
      .limit(1);
    return row ?? null;
  }

  async getWorkflowBySourceHash(sourceHash: string): Promise<WorkflowRow | null> {
    const [row] = await this.db
      .select()
      .from(workflows)
      .where(eq(workflows.source_hash, sourceHash))
      .limit(1);
    return row ?? null;
  }

  // ---- issues ----
  async upsertIssues(issuesIn: Issue[]): Promise<void> {
    if (issuesIn.length === 0) return;
    const now = new Date().toISOString();
    const rows: TablesInsert<'issues'>[] = issuesIn.map((i) => ({
      id: i.id,
      identifier: i.identifier,
      title: i.title,
      description: i.description,
      priority: i.priority,
      state: i.state,
      branch: i.branch,
      labels: i.labels,
      blockers: i.blockers,
      pr_urls: i.pr_urls,
      raw: i as unknown as TablesInsert<'issues'>['raw'],
      last_seen_at: now,
    }));
    await this.db
      .insert(issues)
      .values(rows)
      .onConflictDoUpdate({
        target: issues.id,
        set: {
          identifier: sql`excluded.identifier`,
          title: sql`excluded.title`,
          description: sql`excluded.description`,
          priority: sql`excluded.priority`,
          state: sql`excluded.state`,
          branch: sql`excluded.branch`,
          labels: sql`excluded.labels`,
          blockers: sql`excluded.blockers`,
          pr_urls: sql`excluded.pr_urls`,
          raw: sql`excluded.raw`,
          last_seen_at: sql`excluded.last_seen_at`,
        },
      });
  }

  // ---- runs ----
  /**
   * Insert a `pending` run for an issue. Returns the inserted row, or `null`
   * if another tick already inserted one for `(issue_id, run_number)`.
   */
  async tryReserveRun(input: {
    issueId: string;
    runNumber: number;
    workspacePath: string;
  }): Promise<RunRow | null> {
    try {
      const [row] = await this.db
        .insert(runs)
        .values({
          issue_id: input.issueId,
          run_number: input.runNumber,
          workspace_path: input.workspacePath,
          status: 'pending',
        })
        .returning();
      return row ?? null;
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  /**
   * Transition a run from `pending` to `running`. Throws
   * {@link AlreadyRunningError} if another run for the same issue is already
   * `running` (enforced by the `runs_one_running_per_issue` partial unique
   * index). Callers should treat that as "lost the race; this run should be
   * cancelled" rather than a fatal error.
   */
  async markRunning(runId: string): Promise<void> {
    try {
      await this.db
        .update(runs)
        .set({ status: 'running', started_at: new Date().toISOString() })
        .where(eq(runs.id, runId));
    } catch (err) {
      if (isUniqueViolation(err)) throw new AlreadyRunningError(runId);
      throw err;
    }
  }

  async finishRun(input: {
    runId: string;
    status: Exclude<RunStatus, 'pending' | 'running'>;
    errorClass?: string;
    errorMessage?: string;
  }): Promise<void> {
    await this.db
      .update(runs)
      .set({
        status: input.status,
        ended_at: new Date().toISOString(),
        error_class: input.errorClass ?? null,
        error_message: input.errorMessage ?? null,
      })
      .where(eq(runs.id, input.runId));
  }

  async listRunning(opts?: { issueIds?: string[] }): Promise<RunRow[]> {
    if (opts?.issueIds?.length === 0) return [];
    const where =
      opts?.issueIds && opts.issueIds.length > 0
        ? and(eq(runs.status, 'running'), inArray(runs.issue_id, opts.issueIds))
        : eq(runs.status, 'running');
    return await this.db.select().from(runs).where(where);
  }

  async countRunning(opts?: { issueIds?: string[] }): Promise<number> {
    if (opts?.issueIds?.length === 0) return 0;
    const where =
      opts?.issueIds && opts.issueIds.length > 0
        ? and(eq(runs.status, 'running'), inArray(runs.issue_id, opts.issueIds))
        : eq(runs.status, 'running');
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(runs)
      .where(where);
    return row?.count ?? 0;
  }

  async lastRunNumber(issueId: string): Promise<number> {
    const [row] = await this.db
      .select({ run_number: runs.run_number })
      .from(runs)
      .where(eq(runs.issue_id, issueId))
      .orderBy(desc(runs.run_number))
      .limit(1);
    return row?.run_number ?? 0;
  }

  async hasActiveRun(issueId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(runs)
      .where(and(eq(runs.issue_id, issueId), inArray(runs.status, ['pending', 'running'])));
    return (row?.count ?? 0) > 0;
  }

  async setWorkerPid(runId: string, pid: number): Promise<void> {
    await this.db.update(runs).set({ worker_pid: pid }).where(eq(runs.id, runId));
  }

  // ---- worker_heartbeat ----
  async upsertWorkerHeartbeat(input: { startedAt: Date; workerPid: number }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insert(workerHeartbeat)
      .values({
        id: 'worker',
        started_at: input.startedAt.toISOString(),
        last_beat_at: now,
        worker_pid: input.workerPid,
      })
      .onConflictDoUpdate({
        target: workerHeartbeat.id,
        set: {
          started_at: sql`excluded.started_at`,
          last_beat_at: sql`excluded.last_beat_at`,
          worker_pid: sql`excluded.worker_pid`,
        },
      });
  }

  async beatWorkerHeartbeat(): Promise<void> {
    await this.db
      .update(workerHeartbeat)
      .set({ last_beat_at: new Date().toISOString() })
      .where(eq(workerHeartbeat.id, 'worker'));
  }

  // ---- rate_limit_state ----
  async upsertRateLimit(input: {
    source: string;
    remaining: number | null;
    resetAt: Date | null;
  }): Promise<void> {
    await this.db
      .insert(rateLimitState)
      .values({
        source: input.source,
        remaining: input.remaining,
        reset_at: input.resetAt?.toISOString() ?? null,
        updated_at: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: rateLimitState.source,
        set: {
          remaining: sql`excluded.remaining`,
          reset_at: sql`excluded.reset_at`,
          updated_at: sql`excluded.updated_at`,
        },
      });
  }

  /**
   * Rate-limit rows whose `reset_at` is still in the future. Used by the
   * orchestrator to gate dispatch when an upstream provider has signalled a
   * pause, and by the dashboard to surface the pause state on the KPI strip.
   * Sorted by `reset_at` descending so callers can pick the longest pause
   * with `[0]`.
   */
  async activeRateLimits(now: Date = new Date()): Promise<RateLimitStateRow[]> {
    return await this.db
      .select()
      .from(rateLimitState)
      .where(gt(rateLimitState.reset_at, now.toISOString()))
      .orderBy(desc(rateLimitState.reset_at));
  }

  // ---- live_sessions ----
  async upsertLiveSession(
    input: Omit<LiveSessionRow, 'started_at' | 'last_event_at'>,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insert(liveSessions)
      .values({ ...input, last_event_at: now })
      .onConflictDoUpdate({
        target: liveSessions.run_id,
        set: {
          session_id: sql`excluded.session_id`,
          thread_id: sql`excluded.thread_id`,
          turn_id: sql`excluded.turn_id`,
          input_tokens: sql`excluded.input_tokens`,
          output_tokens: sql`excluded.output_tokens`,
          total_tokens: sql`excluded.total_tokens`,
          last_event_at: sql`excluded.last_event_at`,
        },
      });
  }

  async updateTokens(
    runId: string,
    counts: { input_tokens: number; output_tokens: number; total_tokens: number },
  ): Promise<void> {
    await this.db
      .update(liveSessions)
      .set({ ...counts, last_event_at: new Date().toISOString() })
      .where(eq(liveSessions.run_id, runId));
  }

  async deleteLiveSession(runId: string): Promise<void> {
    await this.db.delete(liveSessions).where(eq(liveSessions.run_id, runId));
  }

  /**
   * Sweep `live_sessions` rows whose `session_id` still has the placeholder
   * shape (`pending-<run-id>`) and whose `run` has reached a terminal state.
   * Codex inserts these placeholder rows on its first token event before the
   * real `<thread_id>-<turn_id>` is known; if the dispatch crashes between
   * that insert and the cleanup at the end of the run, the row outlives its
   * run. Used by boot-time recovery.
   *
   * `issueIds` scopes the sweep so integration tests against a shared
   * database don't touch live worker data. Returns the number of rows deleted.
   */
  async deleteOrphanedPendingSessions(opts?: { issueIds?: string[] }): Promise<number> {
    if (opts?.issueIds?.length === 0) return 0;
    const issueScope = opts?.issueIds && opts.issueIds.length > 0;
    const terminalRunsSubquery = this.db
      .select({ id: runs.id })
      .from(runs)
      .where(
        issueScope
          ? and(
              inArray(runs.status, [...TERMINAL_RUN_STATUSES]),
              inArray(runs.issue_id, opts!.issueIds!),
            )
          : inArray(runs.status, [...TERMINAL_RUN_STATUSES]),
      );

    const deleted = await this.db
      .delete(liveSessions)
      .where(
        and(
          inArray(liveSessions.run_id, terminalRunsSubquery),
          like(liveSessions.session_id, 'pending-%'),
        ),
      )
      .returning({ run_id: liveSessions.run_id });
    return deleted.length;
  }

  // ---- agent_events ----
  async appendEvent(runId: string, kind: AgentEventKind, payload: unknown): Promise<void> {
    await this.db.insert(agentEvents).values({
      run_id: runId,
      kind,
      payload: payload as TablesInsert<'agent_events'>['payload'],
    });
  }

  async recentEvents(runId: string, limit = 50): Promise<AgentEventRow[]> {
    const rows = await this.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.run_id, runId))
      .orderBy(desc(agentEvents.id))
      .limit(limit);
    return rows.reverse();
  }

  /**
   * Most recent run for `issueId` whose `run_number` is strictly less than
   * `beforeRunId`'s. Returns `null` if `beforeRunId` is the first run (or
   * doesn't exist). Used by the retry-context trailer so it reads the *prior*
   * run's `error_class`/`error_message` rather than the not-yet-failed current
   * run's null fields.
   */
  async priorRun(issueId: string, beforeRunId: string): Promise<RunRow | null> {
    const [cur] = await this.db
      .select({ run_number: runs.run_number })
      .from(runs)
      .where(eq(runs.id, beforeRunId))
      .limit(1);
    if (!cur) return null;
    const [prior] = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.issue_id, issueId), lt(runs.run_number, cur.run_number)))
      .orderBy(desc(runs.run_number))
      .limit(1);
    return prior ?? null;
  }

  /**
   * Recent agent events from runs *prior* to `beforeRunId` for the same issue,
   * in chronological order, capped at `limit`. Used by the retry-context
   * trailer — calling `recentEvents(beforeRunId, ...)` would return zero rows
   * because the new run hasn't emitted any events yet.
   */
  async recentEventsForIssue(
    issueId: string,
    beforeRunId: string,
    limit = 10,
  ): Promise<AgentEventRow[]> {
    const [cur] = await this.db
      .select({ run_number: runs.run_number })
      .from(runs)
      .where(eq(runs.id, beforeRunId))
      .limit(1);
    if (!cur) return [];
    const rows = await this.db
      .select({
        id: agentEvents.id,
        run_id: agentEvents.run_id,
        kind: agentEvents.kind,
        payload: agentEvents.payload,
        created_at: agentEvents.created_at,
      })
      .from(agentEvents)
      .innerJoin(runs, eq(agentEvents.run_id, runs.id))
      .where(and(eq(runs.issue_id, issueId), lt(runs.run_number, cur.run_number)))
      .orderBy(desc(agentEvents.id))
      .limit(limit);
    return rows.reverse();
  }

  // ---- retry_queue ----
  async scheduleRetry(input: {
    issueId: string;
    runNumber: number;
    dueAt: Date;
    errorClass: string | null;
    errorMessage: string | null;
  }): Promise<void> {
    await this.db
      .insert(retryQueue)
      .values({
        issue_id: input.issueId,
        run_number: input.runNumber,
        due_at: input.dueAt.toISOString(),
        error_class: input.errorClass,
        error_message: input.errorMessage,
      })
      .onConflictDoUpdate({
        target: retryQueue.issue_id,
        set: {
          run_number: sql`excluded.run_number`,
          due_at: sql`excluded.due_at`,
          error_class: sql`excluded.error_class`,
          error_message: sql`excluded.error_message`,
        },
      });
  }

  async dueRetries(opts?: { issueIds?: string[] }): Promise<RetryQueueRow[]> {
    if (opts?.issueIds?.length === 0) return [];
    const now = new Date().toISOString();
    const where =
      opts?.issueIds && opts.issueIds.length > 0
        ? and(sql`${retryQueue.due_at} <= ${now}`, inArray(retryQueue.issue_id, opts.issueIds))
        : sql`${retryQueue.due_at} <= ${now}`;
    return await this.db.select().from(retryQueue).where(where);
  }

  /**
   * Issue ids that have a scheduled retry in the future. Used by the
   * orchestrator tick to suppress tracker-driven dispatch while backoff is
   * still in effect — without this, a fast-failing issue would be
   * re-dispatched every poll interval regardless of the scheduled due_at.
   */
  async pendingRetryIssueIds(): Promise<Set<string>> {
    const rows = await this.db
      .select({ issue_id: retryQueue.issue_id })
      .from(retryQueue)
      .where(gt(retryQueue.due_at, new Date().toISOString()));
    return new Set(rows.map((r) => r.issue_id));
  }

  /** Issue ids of every row in `retry_queue`, regardless of `due_at`. */
  async allRetryIssueIds(opts?: { issueIds?: string[] }): Promise<string[]> {
    if (opts?.issueIds?.length === 0) return [];
    const where =
      opts?.issueIds && opts.issueIds.length > 0
        ? inArray(retryQueue.issue_id, opts.issueIds)
        : undefined;
    const rows = await this.db
      .select({ issue_id: retryQueue.issue_id })
      .from(retryQueue)
      .where(where);
    return rows.map((r) => r.issue_id);
  }

  async clearRetry(issueId: string): Promise<void> {
    await this.db.delete(retryQueue).where(eq(retryQueue.issue_id, issueId));
  }

  // ---- hook_runs ----
  async recordHook(input: {
    runId: string | null;
    hook: HookName;
    exitCode: number;
    durationMs: number;
    stderrTail: string | null;
  }): Promise<void> {
    await this.db.insert(hookRuns).values({
      run_id: input.runId,
      hook: input.hook,
      exit_code: input.exitCode,
      duration_ms: input.durationMs,
      stderr_tail: input.stderrTail,
    });
  }
}
