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
};

export default nextConfig;
