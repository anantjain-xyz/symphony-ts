import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { type ParsedWorkflow, WorkflowFrontMatter } from '@symphony/shared';
import matter from 'gray-matter';
import { expandString, interpolateEnv } from './interpolate.js';

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
  // Hook scripts are bash source; their `$VAR` tokens are meant to be expanded
  // by the shell at hook runtime (where ISSUE_IDENTIFIER etc. are in scope).
  // Pulling them out before interpolation prevents the loader from eagerly
  // replacing `${ISSUE_IDENTIFIER}` with `""` from the worker's process env.
  const rawHooks = extractHooks(data);
  const interpolated = interpolateEnv(data) as Record<string, unknown>;
  restoreHooks(interpolated, rawHooks);
  dropEmptyOptionalTrackerStrings(interpolated);
  const frontMatter = WorkflowFrontMatter.parse(interpolated);
  // Post-parse so we also process the schema default (which contains ${TMPDIR}).
  frontMatter.workspace.root = resolveWorkspaceRoot(frontMatter.workspace.root);
  return {
    frontMatter,
    promptTemplate: content.trimStart(),
    sourceHash: hash(raw),
  };
}

function extractHooks(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object') return null;
  const hooks = (data as Record<string, unknown>).hooks;
  if (!hooks || typeof hooks !== 'object') return null;
  return { ...(hooks as Record<string, unknown>) };
}

/**
 * Optional tracker fields that the schema declares as `z.string().min(1).optional()`
 * (or url-typed). When an `${ENV_VAR}` reference resolves to "" because the var
 * is unset, we want the field treated as omitted — not as a literal empty
 * string, which would fail validation. Required fields like `api_key` are
 * deliberately not in this list: an unset key should still error loudly.
 */
const OPTIONAL_TRACKER_STRING_KEYS = [
  'workspace',
  'identifier_prefix',
  'project_id',
  'project_slug',
  'project_url',
] as const;

function dropEmptyOptionalTrackerStrings(target: Record<string, unknown>): void {
  const tracker = target.tracker;
  if (!tracker || typeof tracker !== 'object') return;
  const t = tracker as Record<string, unknown>;
  for (const key of OPTIONAL_TRACKER_STRING_KEYS) {
    if (t[key] === '') delete t[key];
  }
}

function restoreHooks(
  target: Record<string, unknown>,
  rawHooks: Record<string, unknown> | null,
): void {
  if (!rawHooks) return;
  const hooks = target.hooks;
  if (!hooks || typeof hooks !== 'object') return;
  // Only restore the script-valued fields; preserve interpolation for scalars
  // like `timeout_ms` if they're ever added.
  for (const [k, v] of Object.entries(rawHooks)) {
    if (typeof v === 'string') (hooks as Record<string, unknown>)[k] = v;
  }
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
