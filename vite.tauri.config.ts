import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const rendererRoot = resolve(import.meta.dirname, 'src/renderer/tauri')

export default defineConfig({
  root: rendererRoot,
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'src-tauri/static'),
    emptyOutDir: true,
  },
})
