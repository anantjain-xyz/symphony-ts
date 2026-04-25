import {
  type AgentEventKind,
  type HookName,
  type Issue,
  type ParsedWorkflow,
  type RunAttemptStatus,
  type SymphonyClient,
  type Tables,
  type TablesInsert,
} from '@symphony/shared';

export class AlreadyRunningError extends Error {
  constructor(public readonly attemptId: string) {
    super(`another attempt for the same issue is already running (lost race for ${attemptId})`);
    this.name = 'AlreadyRunningError';
  }
}

export type RunAttemptRow = Tables<'run_attempts'>;
export type IssueRow = Tables<'issues'>;
export type WorkflowRow = Tables<'workflows'>;
export type LiveSessionRow = Tables<'live_sessions'>;
export type AgentEventRow = Tables<'agent_events'>;
export type RetryQueueRow = Tables<'retry_queue'>;
export type RateLimitStateRow = Tables<'rate_limit_state'>;

/**
 * Typed CRUD over Supabase Postgres. The worker uses the service-role client,
 * so RLS is bypassed; all auth is enforced by virtue of the worker holding the
 * service-role key.
 */
export class Repo {
  constructor(private readonly db: SymphonyClient) {}

  // ---- workflows ----
  async upsertWorkflow(workflow: ParsedWorkflow): Promise<void> {
    const row: TablesInsert<'workflows'> = {
      source_hash: workflow.sourceHash,
      parsed: workflow.frontMatter as unknown as TablesInsert<'workflows'>['parsed'],
      prompt_template: workflow.promptTemplate,
    };
    const { error } = await this.db
      .from('workflows')
      .upsert(row, { onConflict: 'source_hash', ignoreDuplicates: true });
    if (error) throw error;
  }

  async latestWorkflow(): Promise<WorkflowRow | null> {
    const { data, error } = await this.db
      .from('workflows')
      .select('*')
      .order('loaded_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async getWorkflowBySourceHash(sourceHash: string): Promise<WorkflowRow | null> {
    const { data, error } = await this.db
      .from('workflows')
      .select('*')
      .eq('source_hash', sourceHash)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  // ---- issues ----
  async upsertIssues(issues: Issue[]): Promise<void> {
    if (issues.length === 0) return;
    const rows: TablesInsert<'issues'>[] = issues.map((i) => ({
      id: i.id,
      identifier: i.identifier,
      title: i.title,
      description: i.description,
      priority: i.priority,
      state: i.state,
      branch: i.branch,
      labels: i.labels,
      blockers: i.blockers,
      raw: i as unknown as TablesInsert<'issues'>['raw'],
      last_seen_at: new Date().toISOString(),
    }));
    const { error } = await this.db.from('issues').upsert(rows, { onConflict: 'id' });
    if (error) throw error;
  }

  // ---- run_attempts ----
  /**
   * Insert a `pending` attempt for an issue. Returns the inserted row, or
   * `null` if another tick already inserted one for `(issue_id, attempt_number)`.
   */
  async tryReserveAttempt(input: {
    issueId: string;
    attemptNumber: number;
    workspacePath: string;
  }): Promise<RunAttemptRow | null> {
    const { data, error } = await this.db
      .from('run_attempts')
      .insert({
        issue_id: input.issueId,
        attempt_number: input.attemptNumber,
        workspace_path: input.workspacePath,
        status: 'pending',
      })
      .select('*')
      .single();
    if (error) {
      if (error.code === '23505') return null; // unique violation
      throw error;
    }
    return data;
  }

  /**
   * Transition an attempt from `pending` to `running`. Throws
   * {@link AlreadyRunningError} if another attempt for the same issue is
   * already `running` (enforced by the `run_attempts_one_running_per_issue`
   * partial unique index). Callers should treat that as "lost the race; this
   * attempt should be cancelled" rather than a fatal error.
   */
  async markRunning(attemptId: string): Promise<void> {
    const { error } = await this.db
      .from('run_attempts')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', attemptId);
    if (error) {
      if (error.code === '23505') throw new AlreadyRunningError(attemptId);
      throw error;
    }
  }

  async finishAttempt(input: {
    attemptId: string;
    status: Exclude<RunAttemptStatus, 'pending' | 'running'>;
    errorClass?: string;
    errorMessage?: string;
  }): Promise<void> {
    const { error } = await this.db
      .from('run_attempts')
      .update({
        status: input.status,
        ended_at: new Date().toISOString(),
        error_class: input.errorClass ?? null,
        error_message: input.errorMessage ?? null,
      })
      .eq('id', input.attemptId);
    if (error) throw error;
  }

  async listRunning(opts?: { issueIds?: string[] }): Promise<RunAttemptRow[]> {
    let q = this.db.from('run_attempts').select('*').eq('status', 'running');
    if (opts?.issueIds) q = q.in('issue_id', opts.issueIds);
    const { data, error } = await q;
    if (error) throw error;
    return data ?? [];
  }

  async countRunning(opts?: { issueIds?: string[] }): Promise<number> {
    let q = this.db
      .from('run_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'running');
    if (opts?.issueIds) q = q.in('issue_id', opts.issueIds);
    const { count, error } = await q;
    if (error) throw error;
    return count ?? 0;
  }

  async lastAttemptNumber(issueId: string): Promise<number> {
    const { data, error } = await this.db
      .from('run_attempts')
      .select('attempt_number')
      .eq('issue_id', issueId)
      .order('attempt_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data?.attempt_number ?? 0;
  }

  async hasActiveAttempt(issueId: string): Promise<boolean> {
    const { count, error } = await this.db
      .from('run_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('issue_id', issueId)
      .in('status', ['pending', 'running']);
    if (error) throw error;
    return (count ?? 0) > 0;
  }

  async setWorkerPid(attemptId: string, pid: number): Promise<void> {
    const { error } = await this.db
      .from('run_attempts')
      .update({ worker_pid: pid })
      .eq('id', attemptId);
    if (error) throw error;
  }

  // ---- worker_heartbeat ----
  async upsertWorkerHeartbeat(input: { startedAt: Date; workerPid: number }): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.db.from('worker_heartbeat').upsert({
      id: 'worker',
      started_at: input.startedAt.toISOString(),
      last_beat_at: now,
      worker_pid: input.workerPid,
    });
    if (error) throw error;
  }

  async beatWorkerHeartbeat(): Promise<void> {
    const { error } = await this.db
      .from('worker_heartbeat')
      .update({ last_beat_at: new Date().toISOString() })
      .eq('id', 'worker');
    if (error) throw error;
  }

  // ---- rate_limit_state ----
  async upsertRateLimit(input: {
    source: string;
    remaining: number | null;
    resetAt: Date | null;
  }): Promise<void> {
    const { error } = await this.db.from('rate_limit_state').upsert({
      source: input.source,
      remaining: input.remaining,
      reset_at: input.resetAt?.toISOString() ?? null,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  }

  /**
   * Rate-limit rows whose `reset_at` is still in the future. Used by the
   * orchestrator to gate dispatch when an upstream provider has signalled a
   * pause, and by the dashboard to surface the pause state on the KPI strip.
   * Sorted by `reset_at` descending so callers can pick the longest pause
   * with `[0]`.
   */
  async activeRateLimits(now: Date = new Date()): Promise<RateLimitStateRow[]> {
    const { data, error } = await this.db
      .from('rate_limit_state')
      .select('*')
      .gt('reset_at', now.toISOString())
      .order('reset_at', { ascending: false });
    if (error) throw error;
    return data ?? [];
  }

  // ---- live_sessions ----
  async upsertLiveSession(
    input: Omit<LiveSessionRow, 'started_at' | 'last_event_at'>,
  ): Promise<void> {
    const { error } = await this.db.from('live_sessions').upsert({
      ...input,
      last_event_at: new Date().toISOString(),
    });
    if (error) throw error;
  }

  async updateTokens(
    runAttemptId: string,
    counts: { input_tokens: number; output_tokens: number; total_tokens: number },
  ): Promise<void> {
    const { error } = await this.db
      .from('live_sessions')
      .update({ ...counts, last_event_at: new Date().toISOString() })
      .eq('run_attempt_id', runAttemptId);
    if (error) throw error;
  }

  async deleteLiveSession(runAttemptId: string): Promise<void> {
    const { error } = await this.db
      .from('live_sessions')
      .delete()
      .eq('run_attempt_id', runAttemptId);
    if (error) throw error;
  }

  /**
   * Sweep `live_sessions` rows whose `session_id` still has the placeholder
   * shape (`pending-<attempt-id>`) and whose `run_attempt` has reached a
   * terminal state. Codex inserts these placeholder rows on its first token
   * event before the real `<thread_id>-<turn_id>` is known; if the dispatch
   * crashes between that insert and the cleanup at the end of the run,
   * the row outlives its attempt. Used by boot-time recovery.
   *
   * `issueIds` scopes the sweep so integration tests against a shared
   * Supabase don't touch live worker data. Returns the number of rows deleted.
   */
  async deleteOrphanedPendingSessions(opts?: { issueIds?: string[] }): Promise<number> {
    let attemptQ = this.db
      .from('run_attempts')
      .select('id')
      .in('status', ['success', 'failure', 'timeout', 'cancelled']);
    if (opts?.issueIds) attemptQ = attemptQ.in('issue_id', opts.issueIds);
    const { data: terminalAttempts, error: e1 } = await attemptQ;
    if (e1) throw e1;
    if (!terminalAttempts || terminalAttempts.length === 0) return 0;

    const ids = terminalAttempts.map((r) => r.id);
    const { data: deleted, error: e2 } = await this.db
      .from('live_sessions')
      .delete()
      .in('run_attempt_id', ids)
      .like('session_id', 'pending-%')
      .select('run_attempt_id');
    if (e2) throw e2;
    return deleted?.length ?? 0;
  }

  // ---- agent_events ----
  async appendEvent(runAttemptId: string, kind: AgentEventKind, payload: unknown): Promise<void> {
    const { error } = await this.db.from('agent_events').insert({
      run_attempt_id: runAttemptId,
      kind,
      payload: payload as TablesInsert<'agent_events'>['payload'],
    });
    if (error) throw error;
  }

  async recentEvents(runAttemptId: string, limit = 50): Promise<AgentEventRow[]> {
    const { data, error } = await this.db
      .from('agent_events')
      .select('*')
      .eq('run_attempt_id', runAttemptId)
      .order('id', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).reverse();
  }

  // ---- retry_queue ----
  async scheduleRetry(input: {
    issueId: string;
    attemptNumber: number;
    dueAt: Date;
    errorClass: string | null;
    errorMessage: string | null;
  }): Promise<void> {
    const { error } = await this.db.from('retry_queue').upsert(
      {
        issue_id: input.issueId,
        attempt_number: input.attemptNumber,
        due_at: input.dueAt.toISOString(),
        error_class: input.errorClass,
        error_message: input.errorMessage,
      },
      { onConflict: 'issue_id' },
    );
    if (error) throw error;
  }

  async dueRetries(opts?: { issueIds?: string[] }): Promise<RetryQueueRow[]> {
    let q = this.db.from('retry_queue').select('*').lte('due_at', new Date().toISOString());
    if (opts?.issueIds) q = q.in('issue_id', opts.issueIds);
    const { data, error } = await q;
    if (error) throw error;
    return data ?? [];
  }

  /**
   * Issue ids that have a scheduled retry in the future. Used by the
   * orchestrator tick to suppress tracker-driven dispatch while backoff is
   * still in effect — without this, a fast-failing issue would be
   * re-dispatched every poll interval regardless of the scheduled due_at.
   */
  async pendingRetryIssueIds(): Promise<Set<string>> {
    const { data, error } = await this.db
      .from('retry_queue')
      .select('issue_id')
      .gt('due_at', new Date().toISOString());
    if (error) throw error;
    return new Set((data ?? []).map((r) => r.issue_id));
  }

  /** Issue ids of every row in `retry_queue`, regardless of `due_at`. */
  async allRetryIssueIds(opts?: { issueIds?: string[] }): Promise<string[]> {
    let q = this.db.from('retry_queue').select('issue_id');
    if (opts?.issueIds) q = q.in('issue_id', opts.issueIds);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []).map((r) => r.issue_id);
  }

  async clearRetry(issueId: string): Promise<void> {
    const { error } = await this.db.from('retry_queue').delete().eq('issue_id', issueId);
    if (error) throw error;
  }

  // ---- hook_runs ----
  async recordHook(input: {
    runAttemptId: string | null;
    hook: HookName;
    exitCode: number;
    durationMs: number;
    stderrTail: string | null;
  }): Promise<void> {
    const { error } = await this.db.from('hook_runs').insert({
      run_attempt_id: input.runAttemptId,
      hook: input.hook,
      exit_code: input.exitCode,
      duration_ms: input.durationMs,
      stderr_tail: input.stderrTail,
    });
    if (error) throw error;
  }
}
