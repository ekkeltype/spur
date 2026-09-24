import { defineConfig } from 'vitest/config';

// base './' so the static build works under any sub-path (GitHub Pages, itch.io).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    // One bundle for one game (about 180 kB gzipped, PeerJS included): splitting buys nothing.
    chunkSizeWarningLimit: 800,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
