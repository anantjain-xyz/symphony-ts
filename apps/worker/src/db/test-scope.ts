import { randomUUID } from 'node:crypto';
import type { SymphonyClient } from '@symphony/shared';

/**
 * Per-test id tracker for integration tests. Every row a test creates is
 * allocated through the scope, and `cleanup()` deletes exactly those rows —
 * `issues` CASCADE handles `run_attempts`, `retry_queue`, and their children.
 *
 * Tests MUST NOT issue unscoped `.delete().neq(...)` statements — running
 * against a shared Supabase instance, those wipe live worker data.
 */
export class TestScope {
  private readonly _issueIds = new Set<string>();
  private readonly _workflowHashes = new Set<string>();

  get issueIds(): ReadonlySet<string> {
    return this._issueIds;
  }

  newIssueId(): string {
    const id = randomUUID();
    this._issueIds.add(id);
    return id;
  }

  newIdentifier(): string {
    return `TEST-${randomUUID().slice(0, 8)}`;
  }

  newWorkflowHash(): string {
    const hash = randomUUID().replace(/-/g, '').padEnd(64, '0');
    this._workflowHashes.add(hash);
    return hash;
  }

  async cleanup(db: SymphonyClient): Promise<void> {
    if (this._issueIds.size > 0) {
      const { error } = await db
        .from('issues')
        .delete()
        .in('id', [...this._issueIds]);
      if (error) throw error;
    }
    if (this._workflowHashes.size > 0) {
      const { error } = await db
        .from('workflows')
        .delete()
        .in('source_hash', [...this._workflowHashes]);
      if (error) throw error;
    }
  }
}
