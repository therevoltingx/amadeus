import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.MCP_URL': JSON.stringify(process.env.MCP_URL ?? ''),
  },
  server: {
    port: process.env.UI_PORT != null ? parseInt(process.env.UI_PORT, 10) : 5173,
    host: process.env.UI_HOST === 'true' || process.env.UI_HOST === '1'
      ? true
      : process.env.UI_HOST ?? undefined,
    proxy: {
      '/mcp': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/stats': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
