import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

// A Prolibu site is served from /site/<siteCode>/, never from the domain root. For SPA sites
// the platform injects <base href="/site/<siteCode>/"> into the shell before serving it, so
// document.baseURI carries the mount point. Reading it here keeps one bundle working at the
// published URL, at the long canonical URL, and on the local dev server (where it is "/").
const basename = new URL(document.baseURI).pathname

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
