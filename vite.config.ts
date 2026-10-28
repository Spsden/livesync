import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// The app can be mounted at the domain root or under a path. The same value has
// to reach two places: this build (asset + fetch URLs) and the server's
// BASE_PATH, which mounts the router.
//
// Read it from .env as well as the shell, so a plain `npm run build` cannot
// silently produce a root-mounted bundle for a path-hosted deployment. An
// exported BASE_PATH still wins over the file.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '') // '' = every var, not just VITE_*
  const basePath = (env.BASE_PATH ?? '').trim().replace(/\/+$/, '')
  const viteBase = basePath ? `${basePath}/` : '/'

  return {
    base: viteBase,
    plugins: [react()],
    build: {
      outDir: 'dist/client',
      emptyOutDir: true,
      // React + Router + CodeMirror is inherently ~800 kB minified. Splitting it
      // would only delay the editor on the one route that needs it.
      chunkSizeWarningLimit: 900,
    },
    server: {
      proxy: {
        // Keep in sync with the API server's PORT. Configurable because port
        // 3000 is a popular squatter on developer machines.
        '/api': `http://127.0.0.1:${env.SERVER_PORT ?? process.env.SERVER_PORT ?? '3000'}`,
        '/ws': {
          target: `ws://127.0.0.1:${env.SERVER_PORT ?? process.env.SERVER_PORT ?? '3000'}`,
          ws: true,
        },
      },
    },
  }
})
