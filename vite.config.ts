import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    watch: {
      /**
       * This repo keeps a Python virtualenv and the RAG backend's Chroma/SQLite
       * data alongside the frontend. Crawling .venv (torch alone is ~2.5 GB
       * across tens of thousands of files) stalls the dev server on Windows, so
       * the watcher is scoped to frontend sources only.
       */
      ignored: [
        '**/.venv/**',
        '**/ipl_auction_rag_backend/**',
        '**/__pycache__/**',
        '**/dist/**',
        '**/node_modules/**',
      ],
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom/client'],
  },
});
