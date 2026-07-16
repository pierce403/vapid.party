import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Each integration file owns a Miniflare/workerd process. Running several
    // of those socket-heavy environments concurrently is slower and flaky in
    // constrained CI sandboxes than executing the files deterministically.
    fileParallelism: false,
    // Miniflare D1 integration cases deliberately exercise multi-statement
    // locks, trigger cascades, and bounded bulk cleanup. Workerd startup plus
    // those real transactions can exceed Vitest's unit-test default on CI.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
