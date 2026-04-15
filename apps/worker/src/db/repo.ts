import {
  type SymphonyClient,
  type Issue,
  type RunAttemptStatus,
  type AgentEventKind,
  type HookName,
  type ParsedWorkflow,
  type Tables,
  type TablesInsert,
} from '@symphony/shared';

export type RunAttemptRow = Tables<'run_attempts'>;
export type IssueRow = Tables<'issues'>;
export type WorkflowRow = Tables<'workflows'>;
export type LiveSessionRow = Tables<'live_sessions'>;
export type AgentEventRow = Tables<'agent_events'>;
export type RetryQueueRow = Tables<'retry_queue'>;

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

  async markRunning(attemptId: string): Promise<void> {
    const { error } = await this.db
      .from('run_attempts')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', attemptId);
    if (error) throw error;
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

  async listRunning(): Promise<RunAttemptRow[]> {
    const { data, error } = await this.db
      .from('run_attempts')
      .select('*')
      .eq('status', 'running');
    if (error) throw error;
    return data ?? [];
  }

  async countRunning(): Promise<number> {
    const { count, error } = await this.db
      .from('run_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'running');
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

  // ---- live_sessions ----
  async upsertLiveSession(input: Omit<LiveSessionRow, 'started_at' | 'last_event_at'>): Promise<void> {
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

  // ---- agent_events ----
  async appendEvent(
    runAttemptId: string,
    kind: AgentEventKind,
    payload: unknown,
  ): Promise<void> {
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

  async dueRetries(): Promise<RetryQueueRow[]> {
    const { data, error } = await this.db
      .from('retry_queue')
      .select('*')
      .lte('due_at', new Date().toISOString());
    if (error) throw error;
    return data ?? [];
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
