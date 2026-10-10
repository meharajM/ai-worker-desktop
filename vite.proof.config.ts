import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer/proof'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'src-tauri/static-proof'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'src/renderer/proof/index.html'),
        check: resolve(import.meta.dirname, 'src/renderer/proof/check.html'),
      },
    },
  },
})
