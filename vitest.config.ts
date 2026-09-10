import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: [
      'tests/unit/**/*.{test,spec}.{ts,tsx}',
      'tests/integration/**/*.{test,spec}.{ts,tsx}',
    ],
    exclude: ['tests/e2e/**', 'node_modules/**', '.next/**'],
    // The gated integration suites all run against ONE shared database branch, so
    // running their FILES in parallel makes them race each other: they create and
    // delete the same kinds of rows, and RK-3's "only one customer import may be
    // promoted at a time" guard correctly refuses a second concurrent promote — which
    // reads as a spurious failure rather than the real conflict it is. Whenever an
    // integration gate is on, run files one at a time. Unit-only runs stay parallel.
    // Every gate is an env var named RUN_*, so match the convention rather than a
    // hand-kept list that silently rots as suites are added.
    fileParallelism: !Object.keys(process.env).some(
      (k) => k.startsWith('RUN_') && !!process.env[k]
    ),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['lib/**', 'services/**', 'components/**'],
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
