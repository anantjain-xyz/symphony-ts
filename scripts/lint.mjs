#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';

const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.tsx']);
const TEXT_EXTENSIONS = new Set([
  '.css',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.sql',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

const IGNORED_DIRS = new Set([
  '.git',
  '.next',
  'coverage',
  'dist',
  'node_modules',
]);

const targets = process.argv.slice(2);
const inputs = targets.length > 0 ? targets : ['.'];
const files = await collectFiles(inputs);
const findings = [];

for (const file of files) {
  const relPath = path.relative(process.cwd(), file);
  const text = await fs.readFile(file, 'utf8');
  const lines = text.split('\n');

  for (const finding of lintFile(relPath, lines)) {
    findings.push(finding);
  }
}

if (findings.length > 0) {
  console.error('Lint failed:');
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line}: ${finding.message}`);
  }
  process.exit(1);
}

console.log('Lint passed.');

function lintFile(relPath, lines) {
  const ext = path.extname(relPath);
  const out = [];

  if (TEXT_EXTENSIONS.has(ext)) {
    for (let index = 0; index < lines.length; index += 1) {
      if (/^(<<<<<<<|=======|>>>>>>>)($|\s)/.test(lines[index])) {
        out.push({
          file: relPath,
          line: index + 1,
          message: 'merge conflict marker detected',
        });
      }
    }
  }

  if (!CODE_EXTENSIONS.has(ext)) {
    return out;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const previousLine = index > 0 ? lines[index - 1] : '';
    const trimmed = line.trim();

    if (/^debugger(?:;|$)/.test(trimmed)) {
      out.push({
        file: relPath,
        line: index + 1,
        message: 'debugger statements are not allowed',
      });
    }

    if (/^\/\/\s*@ts-ignore\b/.test(trimmed)) {
      out.push({
        file: relPath,
        line: index + 1,
        message: 'prefer a typed fix over @ts-ignore',
      });
    }

    if (/\.(?:only)\s*\(/.test(line)) {
      out.push({
        file: relPath,
        line: index + 1,
        message: 'focused tests are not allowed',
      });
    }

    if (shouldCheckConsole(relPath) && /\bconsole\.(?:log|info|warn|error|debug)\b/.test(line)) {
      const allowConsole =
        /symphony-lint allow-console/.test(line) ||
        /symphony-lint allow-console/.test(previousLine) ||
        /eslint-disable-next-line no-console/.test(previousLine) ||
        /eslint-disable-line no-console/.test(line);
      if (!allowConsole) {
        out.push({
          file: relPath,
          line: index + 1,
          message: 'console usage requires an explicit allow comment',
        });
      }
    }
  }

  return out;
}

function shouldCheckConsole(relPath) {
  const normalized = relPath.split(path.sep).join('/');
  if (!normalized.includes('/src/')) {
    return false;
  }
  return !normalized.includes('.test.');
}

async function collectFiles(inputs) {
  const out = [];
  for (const input of inputs) {
    const resolved = path.resolve(process.cwd(), input);
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      await walk(resolved, out);
      continue;
    }
    if (shouldCheckFile(resolved)) {
      out.push(resolved);
    }
  }
  out.sort();
  return out;
}

async function walk(dir, out) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      await walk(path.join(dir, entry.name), out);
      continue;
    }

    const file = path.join(dir, entry.name);
    if (shouldCheckFile(file)) {
      out.push(file);
    }
  }
}

function shouldCheckFile(file) {
  return TEXT_EXTENSIONS.has(path.extname(file));
}
