import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev and preview servers bind to this Mac only. Phones need an HTTPS host for GPS anyway (see README).
// base is '/' for local dev/preview; set BASE_PATH=/commutelab/ for the GitHub Pages build.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: { output: { manualChunks: { maplibre: ['maplibre-gl'] } } },
  },
});
