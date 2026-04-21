import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
loadDotenv({ path: resolve(repoRoot, '.env.local') });
loadDotenv({ path: resolve(repoRoot, '.env') });

// Expose the Codex adapter path so WORKFLOW.md can reference it via
// `command: node ${SYMPHONY_CODEX_ADAPTER}`. Users can override in their own env.
process.env.SYMPHONY_CODEX_ADAPTER ??= resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../agents/codex-adapter.mjs',
);

import { createServiceClient } from '@symphony/shared';
import { loadWorkflowFile } from './config/workflow.js';
import { resolveConfig } from './config/resolve.js';
import { createLinearClient } from './tracker/linear.js';
import { Repo } from './db/repo.js';
import { recover } from './db/recovery.js';
import { WorkspaceManager } from './workspace/manager.js';
import { OrchestratorLoop } from './orchestrator/loop.js';
import { createLogger } from './logging.js';

async function main(): Promise<void> {
  const log = createLogger();
  log.info({ pid: process.pid, node: process.version }, 'symphony-worker starting');

  const env = requireEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  const workflowPath = resolve(repoRoot, process.env.WORKFLOW_PATH ?? 'WORKFLOW.md');

  const workflow = await loadWorkflowFile(workflowPath);
  log.info({ workflowPath, sourceHash: workflow.sourceHash.slice(0, 12) }, 'workflow loaded');
  const config = resolveConfig(workflow);

  const afterCreate = workflow.frontMatter.hooks.after_create ?? '';
  if (afterCreate.includes('$REPO_URL') && !process.env.REPO_URL) {
    log.warn(
      'after_create references $REPO_URL but REPO_URL env var is empty; workspace init will fail',
    );
  }

  const db = createServiceClient({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });
  const repo = new Repo(db);

  const tracker = createLinearClient({
    endpoint: config.trackerEndpoint(),
    apiKey: config.trackerApiKey(),
    activeStates: config.activeStates(),
    terminalStates: config.terminalStates(),
  });

  const workspaces = new WorkspaceManager(config.workspaceRoot());

  const outcome = await recover({ repo, tracker, workspaces, config, log });
  log.info(outcome, 'recovery complete');

  const loop = new OrchestratorLoop({ tracker, repo, workspaces, config, log });

  let stopRequested = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (stopRequested) {
      log.warn({ signal }, 'second signal received; forcing exit');
      process.exit(1);
    }
    stopRequested = true;
    log.info({ signal }, 'shutdown signal; draining');
    await loop.stop(30_000);
    log.info('drain complete; exiting');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('SIGHUP', () => {
    void (async () => {
      try {
        const next = await loadWorkflowFile(workflowPath);
        if (next.sourceHash === workflow.sourceHash) {
          log.info('SIGHUP: WORKFLOW.md unchanged');
          return;
        }
        // Hot reload not yet hooked into resolveConfig swap; v1 logs and asks
        // operator to restart. Recorded as a TODO in the plan.
        log.warn(
          { newHash: next.sourceHash.slice(0, 12) },
          'SIGHUP: WORKFLOW.md changed; restart worker to apply',
        );
      } catch (err) {
        log.error({ err: errToString(err) }, 'SIGHUP: failed to reload workflow');
      }
    })();
  });

  process.on('uncaughtException', (err) => {
    log.fatal({ err: errToString(err) }, 'uncaughtException');
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    log.fatal({ err: errToString(err) }, 'unhandledRejection');
    process.exit(1);
  });

  log.info(
    {
      pollIntervalMs: config.pollIntervalMs(),
      maxConcurrentAgents: config.maxConcurrentAgents(),
      workspaceRoot: config.workspaceRoot(),
    },
    'orchestrator loop starting',
  );

  await loop.run();
  log.info('loop exited');
}

function requireEnv<K extends string>(keys: readonly K[]): Record<K, string> {
  const out = {} as Record<K, string>;
  const missing: string[] = [];
  for (const k of keys) {
    const v = process.env[k];
    if (!v) missing.push(k);
    else out[k] = v;
  }
  if (missing.length > 0) {
    throw new Error(`missing required env vars: ${missing.join(', ')}`);
  }
  return out;
}

function errToString(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

main().catch((err) => {
  // biome-ignore lint/suspicious/noConsole: last-resort catcher; logger may not be initialized
  console.error('fatal:', err);
  process.exit(1);
});
