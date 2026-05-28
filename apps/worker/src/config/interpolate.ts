import { tmpdir } from 'node:os';

/**
 * Shared `${VAR}` / `$VAR` env-var interpolation used by both WORKFLOW.md and
 * repos.md parsers. Missing vars expand to the empty string; `${VAR:-default}`
 * applies the default when the var is unset OR empty (bash semantics).
 *
 * TMPDIR has a built-in fallback to `os.tmpdir()` because Linux typically does
 * not export it and the spec defaults `workspace.root` to system temp.
 */

const ENV_FALLBACKS: Readonly<Record<string, () => string>> = {
  TMPDIR: () => tmpdir(),
};

const ENV_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}|\$([A-Z_][A-Z0-9_]*)/g;

export function expandString(s: string): string {
  return s.replace(
    ENV_PATTERN,
    (
      _,
      braced: string | undefined,
      bracedDefault: string | undefined,
      bare: string | undefined,
    ) => {
      const name = braced ?? bare;
      if (!name) return '';
      const fromEnv = process.env[name];
      if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
      if (bracedDefault !== undefined) return bracedDefault;
      const fallback = ENV_FALLBACKS[name];
      return fallback ? fallback() : '';
    },
  );
}

export function interpolateEnv(value: unknown): unknown {
  if (typeof value === 'string') return expandString(value);
  if (Array.isArray(value)) return value.map(interpolateEnv);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateEnv(v);
    return out;
  }
  return value;
}
