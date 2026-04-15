import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import {
  WorkflowFrontMatter,
  type ParsedWorkflow,
} from '@symphony/shared';

/**
 * Read WORKFLOW.md from disk, parse front matter, expand env vars and ~ in
 * paths, validate against the zod schema. Body of the markdown is treated as
 * the prompt template.
 */
export async function loadWorkflowFile(workflowPath: string): Promise<ParsedWorkflow> {
  const raw = await readFile(workflowPath, 'utf8');
  return parseWorkflowSource(raw);
}

export function parseWorkflowSource(raw: string): ParsedWorkflow {
  const { data, content } = matter(raw);
  const interpolated = interpolateEnv(data) as Record<string, unknown>;
  const frontMatter = WorkflowFrontMatter.parse(interpolated);
  // Post-parse so we also process the schema default (which contains ${TMPDIR}).
  frontMatter.workspace.root = resolveWorkspaceRoot(frontMatter.workspace.root);
  return {
    frontMatter,
    promptTemplate: content.trimStart(),
    sourceHash: hash(raw),
  };
}

/**
 * Recursively replace `${VAR}` and `$VAR` tokens in any string value with
 * `process.env[VAR]`. Missing vars are left as the empty string. TMPDIR has
 * a built-in fallback to `os.tmpdir()` because the spec defaults workspace.root
 * to system temp and we need that to resolve even when the env var is unset
 * (e.g. on Linux the variable is conventionally not exported).
 */
function interpolateEnv(value: unknown): unknown {
  if (typeof value === 'string') return expandString(value);
  if (Array.isArray(value)) return value.map(interpolateEnv);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateEnv(v);
    return out;
  }
  return value;
}

const ENV_FALLBACKS: Readonly<Record<string, () => string>> = {
  TMPDIR: () => tmpdir(),
};

const ENV_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g;
function expandString(s: string): string {
  return s.replace(ENV_PATTERN, (_, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare;
    if (!name) return '';
    const fromEnv = process.env[name];
    if (fromEnv !== undefined) return fromEnv;
    const fallback = ENV_FALLBACKS[name];
    return fallback ? fallback() : '';
  });
}

/**
 * Final pass over workspace.root after defaults are applied: env interpolation,
 * ~ expansion, OS path normalization. Run separately because the schema default
 * value `${TMPDIR}/symphony-workspaces` is a literal string until it lands in
 * the parsed object.
 */
function resolveWorkspaceRoot(root: string): string {
  let resolved = expandString(root);
  if (resolved.startsWith('~/') || resolved === '~') {
    resolved = path.join(homedir(), resolved.slice(1));
  }
  return path.normalize(resolved);
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
