import { mergeConfig } from 'vite'
import baseConfig from './vite.config.ts'

// Reuse the application configuration while sharing Radix's focus/layer stacks
// across Dialog, Popover and Select, even with different transitive versions.
export default mergeConfig(baseConfig, {
  resolve: {
    dedupe: [
      '@radix-ui/react-focus-scope',
      '@radix-ui/react-dismissable-layer',
    ],
  },
})
