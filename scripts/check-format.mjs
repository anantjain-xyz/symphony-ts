#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';

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

const args = process.argv.slice(2);
const write = args.includes('--write');
const roots = args.filter((arg) => arg !== '--write');
const targets = roots.length > 0 ? roots : ['.'];

const files = await collectFiles(targets);
const changed = [];

for (const file of files) {
  const original = await fs.readFile(file, 'utf8');
  const formatted = normalizeWhitespace(original);
  if (formatted === original) {
    continue;
  }

  if (write) {
    await fs.writeFile(file, formatted, 'utf8');
  }

  changed.push(path.relative(process.cwd(), file));
}

if (changed.length > 0) {
  const header = write ? 'Updated:' : 'Needs formatting:';
  console.error(header);
  for (const file of changed) {
    console.error(`- ${file}`);
  }
  process.exitCode = write ? 0 : 1;
} else {
  console.log(write ? 'Formatting already up to date.' : 'Formatting check passed.');
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

function normalizeWhitespace(input) {
  let next = input.replace(/\r\n/g, '\n');
  next = next.replace(/[ \t]+$/gm, '');

  if (next.length === 0) {
    return next;
  }

  return `${next.replace(/\n*$/g, '')}\n`;
}
