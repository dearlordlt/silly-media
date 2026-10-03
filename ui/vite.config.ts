import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The app is served from `/ui/` by ui.sh (and by any static host under that
// prefix), so asset URLs and the router base must both be `/ui/`.
export default defineConfig(({ mode }) => {
  // `ui.sh --dev` starts the app server (`ui/server/index.mjs --api-only`) and
  // exports its URL; loadEnv also picks up SILLY_* from the process env.
  const appApi = loadEnv(mode, '.', 'SILLY_').SILLY_APP_API || 'http://127.0.0.1:5280'
  return {
    base: '/ui/',
    plugins: [react(), tailwindcss()],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      chunkSizeWarningLimit: 1500,
    },
    server: {
      port: 5273,
      strictPort: true,
      proxy: {
        '/app-api': { target: appApi },
      },
    },
  }
})
