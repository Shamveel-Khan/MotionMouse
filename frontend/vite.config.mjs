import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev uses the same LAN certificate as the documented backend setup.
// Certificate files are read only when the user starts the development server.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  server: command === 'serve' ? {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    https: {
      key: readFileSync(fileURLToPath(new URL('../certs/laptop-key.pem', import.meta.url))),
      cert: readFileSync(fileURLToPath(new URL('../certs/laptop.pem', import.meta.url))),
    },
    proxy: {
      '/ws': { target: 'https://127.0.0.1:8000', ws: true, secure: false },
      '/api': { target: 'https://127.0.0.1:8000', secure: false },
    },
  } : undefined,
}));
