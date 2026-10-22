import { defineConfig, mergeConfig } from 'vite'
import baseConfig from './vite.config'

const config = mergeConfig(
  baseConfig,
  defineConfig({
    server: {
      host: '127.0.0.1',
      port: 9999,
      strictPort: true,
      proxy: {
        '/api/v1': {
          target: 'http://127.0.0.1:8003',
          changeOrigin: true,
          ws: true,
        },
        '/agent-api': {
          target: 'http://127.0.0.1:8005',
          changeOrigin: true,
          ws: true,
          rewrite: (path) => path.replace(/^\/agent-api/, ''),
        },
      },
    },
  })
)

export default config
