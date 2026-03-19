import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      externalizeDeps: false,
      rollupOptions: {
        external: ['electron'],
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      externalizeDeps: false,
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    define: {
      __MLB_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
      outDir: 'dist/renderer',
    },
  },
});
