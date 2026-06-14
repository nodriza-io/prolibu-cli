/// <reference types="vite/client" />

interface ProlibuConfig {
  apiKey: string
  domain: string
  prefix: string
  siteId: string
}

interface Window {
  __PROLIBU_CONFIG__?: ProlibuConfig
}
