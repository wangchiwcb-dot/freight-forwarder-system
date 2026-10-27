import { defineConfig } from 'vite';
export default defineConfig({
  publicDir: false,
  build: { ssr: 'server/v2/index.ts', outDir: 'dist-server', target: 'node22',
    rollupOptions: { output: { entryFileNames: 'index.js' } } },
  ssr: { external: ['pg', 'fastify', 'zod', 'decimal.js', '@electric-sql/pglite'] },
});
