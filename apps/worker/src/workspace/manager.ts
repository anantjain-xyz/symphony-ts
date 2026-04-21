import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Sentinel written at the workspace root once after_create completes cleanly.
 * Presence = "after_create succeeded, workspace is usable."
 * Absence = "workspace was never initialized, or a previous after_create
 * crashed partway" → re-run after_create from a clean slate.
 */
export const WORKSPACE_READY_SENTINEL = '.symphony-workspace-ready';

/**
 * Convert an issue identifier into a filesystem-safe directory name.
 * Sanitization rule: any char not in `[A-Za-z0-9_-]` becomes `_`.
 * The result is also prevented from being `.`, `..`, or empty.
 */
export function sanitizeKey(identifier: string): string {
  if (identifier === '' || identifier === '.' || identifier === '..') return '_';
  return identifier.replace(/[^A-Za-z0-9_-]/g, '_');
}

export interface Workspace {
  /** Absolute path to the workspace directory. */
  path: string;
  /** Sanitized identifier used for the directory name. */
  key: string;
  /** True when this call created the directory (false when it already existed). */
  createdNow: boolean;
  /**
   * True when after_create needs to run: directory was just created, or it
   * existed but the ready-sentinel was missing (prior init crashed or the
   * hook script changed). When this is true with `createdNow: false`, the
   * directory contents have been wiped so after_create can re-initialize from
   * scratch.
   */
  needsInit: boolean;
}

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  /**
   * Resolve a workspace path under the configured root and create it if needed.
   * Reuses an existing *and healthy* directory across retries. A directory
   * that exists but lacks the ready-sentinel is treated as corrupt: its
   * contents are wiped and `needsInit: true` is returned so the caller
   * re-runs after_create.
   */
  async createOrReuse(identifier: string): Promise<Workspace> {
    const key = sanitizeKey(identifier);
    const wsPath = this.assertSafePath(key);
    let createdNow = false;
    try {
      await stat(wsPath);
    } catch {
      await mkdir(wsPath, { recursive: true });
      createdNow = true;
    }

    let needsInit = createdNow;
    if (!createdNow) {
      try {
        await stat(path.join(wsPath, WORKSPACE_READY_SENTINEL));
      } catch {
        // Sentinel missing → wipe and re-init. rm+mkdir (rather than emptying
        // entries in place) keeps the implementation simple.
        await rm(wsPath, { recursive: true, force: true });
        await mkdir(wsPath, { recursive: true });
        needsInit = true;
      }
    }

    return { path: wsPath, key, createdNow, needsInit };
  }

  /**
   * Mark a workspace as ready (call after a successful after_create). Writes
   * the sentinel file so subsequent createOrReuse calls reuse the workspace.
   */
  async markReady(identifier: string): Promise<void> {
    const key = sanitizeKey(identifier);
    const wsPath = this.assertSafePath(key);
    await writeFile(path.join(wsPath, WORKSPACE_READY_SENTINEL), '');
  }

  /**
   * Remove a workspace directory. Caller is responsible for running before_remove
   * hook first.
   */
  async remove(identifier: string): Promise<void> {
    const key = sanitizeKey(identifier);
    const wsPath = this.assertSafePath(key);
    await rm(wsPath, { recursive: true, force: true });
  }

  /**
   * Resolve the (possibly non-existent) workspace path for an identifier
   * without creating anything.
   */
  pathFor(identifier: string): string {
    return this.assertSafePath(sanitizeKey(identifier));
  }

  /**
   * Reject any `key` that resolves outside the workspace root after path
   * normalization. sanitizeKey already strips `..` and `/`, but we double-check
   * to defend against future changes to the sanitizer.
   */
  private assertSafePath(key: string): string {
    const resolved = path.resolve(this.root, key);
    const rootResolved = path.resolve(this.root);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      throw new Error(`Workspace key escaped root: ${key}`);
    }
    return resolved;
  }
}
