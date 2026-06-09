import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const appDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: '/tango-workout/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(appDir, 'src'),
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:9330',
    },
  },
});
