import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Integration tests share a single Supabase DB; running test files in
    // parallel causes them to stomp on each other's rows during cleanup.
    fileParallelism: false,
  },
});
