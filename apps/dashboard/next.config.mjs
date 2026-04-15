/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // We import @symphony/shared from a sibling workspace package; transpile it
  // so Next handles the TS source directly.
  transpilePackages: ['@symphony/shared'],
};

export default nextConfig;
