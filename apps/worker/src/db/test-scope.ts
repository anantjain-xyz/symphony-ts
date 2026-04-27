import { randomUUID } from 'node:crypto';
import { type Db, issues, rateLimitState, workflows } from '@symphony/shared';
import { inArray } from 'drizzle-orm';

/**
 * Per-test id tracker for integration tests. Every row a test creates is
 * allocated through the scope, and `cleanup()` deletes exactly those rows —
 * `issues` CASCADE handles `runs`, `retry_queue`, and their children.
 *
 * Tests MUST NOT issue unscoped delete statements — running against a shared
 * database, those wipe live worker data.
 */
export class TestScope {
  private readonly _issueIds = new Set<string>();
  private readonly _workflowHashes = new Set<string>();
  private readonly _rateLimitSources = new Set<string>();

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

  /**
   * Allocate a `rate_limit_state.source` value scoped to this test. Tests use
   * the returned string as the `source` column when seeding pause rows; the
   * scope tracks them so `cleanup()` removes only its own rows — never the
   * live worker's `codex_*` / `claude_*` entries on a shared database.
   */
  newRateLimitSource(prefix: string): string {
    const source = `${prefix}__test-${randomUUID().slice(0, 8)}`;
    this._rateLimitSources.add(source);
    return source;
  }

  async cleanup(db: Db): Promise<void> {
    if (this._issueIds.size > 0) {
      await db.delete(issues).where(inArray(issues.id, [...this._issueIds]));
    }
    if (this._workflowHashes.size > 0) {
      await db.delete(workflows).where(inArray(workflows.source_hash, [...this._workflowHashes]));
    }
    if (this._rateLimitSources.size > 0) {
      await db
        .delete(rateLimitState)
        .where(inArray(rateLimitState.source, [...this._rateLimitSources]));
    }
  }
}
