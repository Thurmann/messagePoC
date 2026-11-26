import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { CSP } from './build-tools/csp';
import { themeScript } from './build-tools/themeScript';

export default defineConfig({
  base: '/',
  plugins: [react(), themeScript()],
  build: {
    outDir: 'build/vite',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    modulePreload: { polyfill: false },
  },
  server: {
    proxy: { '/api': 'http://localhost:8083' },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    headers: { 'Content-Security-Policy': CSP },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'build-tools/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
    reporters: ['default', 'junit'],
    outputFile: { junit: 'build/test-results/vitest/junit.xml' },
  },
});
