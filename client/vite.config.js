import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The build lands in server/public so Express serves the app and the API from a
 * single origin — one Azure App Service, one URL, no CORS.
 *
 * In dev, /api is proxied to the Express process so the frontend talks to the
 * same endpoints it will use in production.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.PORT || 8080}`,
        changeOrigin: true,
      },
    },
  },
});
