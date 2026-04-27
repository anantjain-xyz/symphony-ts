#!/usr/bin/env tsx
/**
 * Remove fixtures inserted by `seed-mock.ts`. Scoped strictly to rows the mock
 * seed owns — real tracker-sourced issues and worker heartbeat are left alone.
 *
 *   DATABASE_URL=... pnpm --filter @symphony/worker exec tsx scripts/seed-mock-clear.ts
 *
 * The mock seed uses `mock-*` as the `issues.id` prefix; FK cascades from
 * `issues` clear `runs`, `agent_events`, `live_sessions`, and `retry_queue`.
 * The only out-of-band row is the `claude_primary` rate-limit pause.
 */

import { createDb, type Db, issues, rateLimitState } from '@symphony/shared';
import { eq, like } from 'drizzle-orm';

const URL = process.env.DATABASE_URL;
if (!URL) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

async function main() {
  const db = createDb(URL!, { max: 1 });

  const removedIssues = await db
    .delete(issues)
    .where(like(issues.id, 'mock-%'))
    .returning({ id: issues.id, identifier: issues.identifier });

  const removedRateLimits = await db
    .delete(rateLimitState)
    .where(eq(rateLimitState.source, 'claude_primary'))
    .returning({ source: rateLimitState.source });

  console.log(`Removed ${removedIssues.length} mock issues (cascade clears runs, events, sessions, retries).`);
  for (const i of removedIssues) console.log(`  - ${i.identifier}`);
  console.log(`Removed ${removedRateLimits.length} mock rate_limit_state rows.`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as Db & { $client: { end: (o: { timeout: number }) => Promise<void> } }).$client.end({
    timeout: 5,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
