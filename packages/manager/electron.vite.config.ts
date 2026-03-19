import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      // Bundle ALL deps into output (pnpm symlinks break in asar)
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
    build: {
      outDir: 'dist/renderer',
    },
  },
});
