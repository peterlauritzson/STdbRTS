import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      // index.html is the game; guide.html is the in-game player guide.
      input: {
        main: resolve(__dirname, 'index.html'),
        guide: resolve(__dirname, 'guide.html'),
      },
    },
  },
});
