import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    globals: true
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name].js`,
        chunkFileNames: `assets/[name].js`,
        assetFileNames: `assets/[name].[ext]`
        // Deliberately no manualChunks. recharts and xlsx are reached only through dynamic
        // imports (RentChart and the export handler), and Rollup already splits those into
        // their own chunks. Naming them in manualChunks actually *undid* that: a manual
        // chunk joins the entry's static graph, so index.js imported recharts.js eagerly
        // and index.html preloaded it -- exactly the cost the split was meant to remove.
      }
    }
  }
})
