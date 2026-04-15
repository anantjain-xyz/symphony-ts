import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

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
}

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  /**
   * Resolve a workspace path under the configured root and create it if needed.
   * Reuses an existing directory across retries (spec: "Created once, preserved
   * across retries").
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
    return { path: wsPath, key, createdNow };
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
