/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly ROWS_PER_PAGE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
