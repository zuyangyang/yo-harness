import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    // e2e 用例会 spawn tsx 子进程，冷启动较慢
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
