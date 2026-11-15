import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = `http://localhost:${process.env.WEB_PORT ?? 8080}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    host: true, // reachable from a phone on the LAN
    proxy: {
      '/api': api,
      '/ws': { target: api.replace('http', 'ws'), ws: true },
    },
  },
});
