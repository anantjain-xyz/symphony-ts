import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nextEnv from '@next/env';

const { loadEnvConfig } = nextEnv;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
loadEnvConfig(repoRoot);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // We import @symphony/shared from a sibling workspace package; transpile it
  // so Next handles the TS source directly.
  transpilePackages: ['@symphony/shared'],
  // Self-contained server bundle for the docker image (server.js + minimal
  // node_modules); next.js traces files from the monorepo root.
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
