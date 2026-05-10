import { formatError } from '@symphony/shared';
import type { Logger } from 'pino';
import type { Repo } from '../db/repo.js';

export interface HeartbeatOptions {
  /** How often to refresh worker_heartbeat.last_beat_at. Default 2s. */
  intervalMs?: number;
}

/**
 * Periodically writes `worker_heartbeat.last_beat_at = now()` so the dashboard
 * can display worker uptime and detect a dead/stalled worker process.
 *
 * `start()` upserts the startup row synchronously, then installs an interval
 * timer that issues cheap UPDATEs. Failures are logged and swallowed — a
 * missed beat shouldn't take down the orchestrator.
 */
export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private readonly startedAt = new Date();
  constructor(
    private readonly repo: Repo,
    private readonly log: Logger,
  ) {}

  async start(opts: HeartbeatOptions = {}): Promise<void> {
    const intervalMs = opts.intervalMs ?? 2_000;
    await this.repo.upsertWorkerHeartbeat({
      startedAt: this.startedAt,
      workerPid: process.pid,
    });
    this.timer = setInterval(() => {
      void this.repo
        .beatWorkerHeartbeat()
        .catch((err) => this.log.warn({ err: formatError(err) }, 'heartbeat failed'));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
