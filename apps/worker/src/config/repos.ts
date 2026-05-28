import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type Issue, type ParsedRepos, type RepoEntry, ReposFrontMatter } from '@symphony/shared';
import matter from 'gray-matter';
import { interpolateEnv } from './interpolate.js';

/**
 * Read repos.md from disk. Throws if the file is missing — repos.md is
 * required: the worker has no legacy single-repo fallback. Operators must
 * provide a registry listing every target repo.
 */
export async function loadReposFile(reposPath: string): Promise<ParsedRepos> {
  const raw = await readFile(reposPath, 'utf8');
  return parseReposSource(raw);
}

export function parseReposSource(raw: string): ParsedRepos {
  const { data } = matter(raw);
  // install_cmd is bash source executed by the hook runner; its `$VAR` tokens
  // (notably `$HOME` for nvm bootstrap) are meant to expand at hook time, not
  // load time. Mirror workflow.ts's hook extract/restore pattern so the
  // loader doesn't eagerly replace them.
  const rawInstallCmds = extractInstallCmds(data);
  const interpolated = interpolateEnv(data) as Record<string, unknown>;
  restoreInstallCmds(interpolated, rawInstallCmds);
  const frontMatter = ReposFrontMatter.parse(interpolated);

  const seenNames = new Set<string>();
  const seenLabels = new Set<string>();
  for (const entry of frontMatter.repos) {
    if (seenNames.has(entry.name)) {
      throw new Error(`repos.md: duplicate repo name "${entry.name}"`);
    }
    seenNames.add(entry.name);
    const label = labelFor(entry);
    if (seenLabels.has(label)) {
      throw new Error(`repos.md: duplicate routing label "${label}"`);
    }
    seenLabels.add(label);
  }

  return { frontMatter, sourceHash: hash(raw) };
}

/** Default routing label is `repo:<name>` unless the entry overrides `label`. */
export function labelFor(entry: RepoEntry): string {
  return entry.label ?? `repo:${entry.name}`;
}

/**
 * Pick the repo for an issue by `repo:*` label. Returns null when no label
 * matches — there is no default fallback. The orchestrator treats a null
 * result as "ineligible, skip silently" rather than as a dispatch failure.
 */
export function resolveRepoForIssue(repos: ParsedRepos, issue: Issue): RepoEntry | null {
  const labels = issue.labels;
  for (const entry of repos.frontMatter.repos) {
    const label = labelFor(entry);
    if (labels.includes(label)) return entry;
  }
  return null;
}

function extractInstallCmds(data: unknown): (string | undefined)[] | null {
  if (!data || typeof data !== 'object') return null;
  const repos = (data as Record<string, unknown>).repos;
  if (!Array.isArray(repos)) return null;
  return repos.map((r) => {
    if (!r || typeof r !== 'object') return undefined;
    const v = (r as Record<string, unknown>).install_cmd;
    return typeof v === 'string' ? v : undefined;
  });
}

function restoreInstallCmds(
  target: Record<string, unknown>,
  rawCmds: (string | undefined)[] | null,
): void {
  if (!rawCmds) return;
  const repos = target.repos;
  if (!Array.isArray(repos)) return;
  for (let i = 0; i < repos.length; i++) {
    const cmd = rawCmds[i];
    if (cmd === undefined) continue;
    const entry = repos[i];
    if (entry && typeof entry === 'object') {
      (entry as Record<string, unknown>).install_cmd = cmd;
    }
  }
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
