import type { Issue } from '@symphony/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { labelFor, parseReposSource, resolveRepoForIssue } from './repos.js';

const SRC_TWO = `---
repos:
  - name: backend-api
    repo_url: https://example.com/your-org/backend-api
    install_cmd: npm ci
  - name: frontend-app
    repo_url: https://example.com/your-org/frontend-app
    install_cmd: 'cd $HOME && npm ci'
    env:
      APP_SESSION_COOKIE: \${APP_SESSION_COOKIE}
---

# Repos
`;

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'iss-1',
    identifier: 'TEAM-42',
    title: 't',
    description: null,
    priority: 0,
    state: 'todo',
    branch: null,
    labels: [],
    blockers: [],
    pr_urls: [],
    ...overrides,
  };
}

describe('parseReposSource', () => {
  const origCookie = process.env.APP_SESSION_COOKIE;
  beforeEach(() => {
    process.env.APP_SESSION_COOKIE = 'cookie-from-env';
  });
  afterEach(() => {
    if (origCookie === undefined) delete process.env.APP_SESSION_COOKIE;
    else process.env.APP_SESSION_COOKIE = origCookie;
  });

  it('parses entries and interpolates ${VAR} in env: blocks', () => {
    const r = parseReposSource(SRC_TWO);
    expect(r.frontMatter.repos).toHaveLength(2);
    const [first, second] = r.frontMatter.repos;
    expect(first?.name).toBe('backend-api');
    expect(second?.env).toEqual({
      APP_SESSION_COOKIE: 'cookie-from-env',
    });
  });

  it('preserves $VAR in install_cmd so bash expands at hook time, not parse time', () => {
    // Otherwise nvm bootstrap (`. "$HOME/.nvm/nvm.sh"`) would be frozen to
    // the worker process's $HOME at startup.
    const r = parseReposSource(SRC_TWO);
    expect(r.frontMatter.repos[1]?.install_cmd).toBe('cd $HOME && npm ci');
  });

  it('produces a stable sourceHash', () => {
    const a = parseReposSource(SRC_TWO);
    const b = parseReposSource(SRC_TWO);
    expect(a.sourceHash).toBe(b.sourceHash);
    expect(a.sourceHash).toHaveLength(64);
  });

  it('rejects duplicate names', () => {
    const src = `---
repos:
  - name: a
    repo_url: https://example.com/a
  - name: a
    repo_url: https://example.com/a2
---`;
    expect(() => parseReposSource(src)).toThrow(/duplicate repo name/);
  });

  it('rejects duplicate routing labels', () => {
    const src = `---
repos:
  - name: a
    repo_url: https://example.com/a
    label: repo:shared
  - name: b
    repo_url: https://example.com/b
    label: repo:shared
---`;
    expect(() => parseReposSource(src)).toThrow(/duplicate routing label/);
  });

  it('rejects unknown fields like the removed `default:`', () => {
    // The `default` flag was removed when the routing rule changed to "no
    // label = not picked up". The strict schema rejects it so a stale config
    // surfaces loudly instead of silently doing nothing.
    const src = `---
repos:
  - name: a
    repo_url: https://example.com/a
    default: true
---`;
    expect(() => parseReposSource(src)).toThrow();
  });

  it('rejects non-kebab-case names', () => {
    const src = `---
repos:
  - name: Stablecoin_Graphql
    repo_url: https://example.com/x
---`;
    expect(() => parseReposSource(src)).toThrow();
  });

  it('rejects an empty repos list', () => {
    const src = `---
repos: []
---`;
    expect(() => parseReposSource(src)).toThrow();
  });
});

describe('resolveRepoForIssue', () => {
  it('matches the first repo:<name> label', () => {
    const r = parseReposSource(SRC_TWO);
    const issue = makeIssue({ labels: ['needs-review', 'repo:frontend-app'] });
    expect(resolveRepoForIssue(r, issue)?.name).toBe('frontend-app');
  });

  it('returns null when no repo:* label is present (no default fallback)', () => {
    const r = parseReposSource(SRC_TWO);
    expect(resolveRepoForIssue(r, makeIssue({ labels: ['needs-review'] }))).toBeNull();
    expect(resolveRepoForIssue(r, makeIssue({ labels: [] }))).toBeNull();
  });

  it('returns null when no label matches a configured entry', () => {
    const r = parseReposSource(SRC_TWO);
    expect(resolveRepoForIssue(r, makeIssue({ labels: ['repo:not-a-real-target'] }))).toBeNull();
  });

  it('matches an explicit `label:` override over the implicit repo:<name>', () => {
    const r = parseReposSource(`---
repos:
  - name: a
    repo_url: https://example.com/a
    label: target:legacy-a
---`);
    expect(resolveRepoForIssue(r, makeIssue({ labels: ['target:legacy-a'] }))?.name).toBe('a');
    // implicit repo:a should NOT match when label override is set
    expect(resolveRepoForIssue(r, makeIssue({ labels: ['repo:a'] }))).toBeNull();
  });
});

describe('labelFor', () => {
  it('defaults to repo:<name>', () => {
    expect(labelFor({ name: 'foo', repo_url: 'x' } as never)).toBe('repo:foo');
  });
  it('uses an explicit label override', () => {
    expect(labelFor({ name: 'foo', repo_url: 'x', label: 'other:foo' } as never)).toBe('other:foo');
  });
});
