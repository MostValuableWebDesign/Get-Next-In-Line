import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    globals: false,
    // The suite runs alongside other validation commands (api-server
    // integration tests, typechecks) on a shared machine; the 5s defaults
    // flake under that load — a different jsdom test times out each run and
    // passes in isolation. Give tests and hooks the same headroom the
    // api-server suite uses.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
