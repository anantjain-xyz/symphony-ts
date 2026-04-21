import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function readJson(relativePath) {
  const filePath = path.join(repoRoot, relativePath);
  const contents = await readFile(filePath, 'utf8');
  return JSON.parse(contents);
}

test('package scripts expose CI entrypoints', async () => {
  const packageJson = await readJson('package.json');

  assert.equal(
    packageJson.scripts['format:check'],
    'pnpm dlx @biomejs/biome@2.2.3 format --check .',
  );
  assert.equal(packageJson.scripts.lint, 'pnpm dlx @biomejs/biome@2.2.3 lint .');
  assert.equal(packageJson.scripts.test, 'pnpm -r test && node --test tests/**/*.test.mjs');
});

test('CI workflow runs formatting, linting, and test checks', async () => {
  const workflow = await readFile(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /name:\s+Format/);
  assert.match(workflow, /command:\s+pnpm format:check/);
  assert.match(workflow, /name:\s+Lint/);
  assert.match(workflow, /command:\s+pnpm lint/);
  assert.match(workflow, /name:\s+Test/);
  assert.match(workflow, /command:\s+pnpm test/);
});

test('biome config is valid JSON', async () => {
  const biomeConfig = await readJson('biome.json');

  assert.equal(typeof biomeConfig, 'object');
  assert.notEqual(biomeConfig, null);
});
