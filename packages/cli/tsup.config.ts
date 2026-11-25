import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  // Keep `node:` prefixes: `node:sqlite` has no bare `sqlite` alias.
  removeNodeProtocol: false,
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
});
