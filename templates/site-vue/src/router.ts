import { createRouter, createWebHistory } from 'vue-router'
import DashboardPage from './pages/DashboardPage.vue'

// A Prolibu site is served from /site/<siteCode>/, never from the domain root. For SPA sites
// the platform injects <base href="/site/<siteCode>/"> into the shell before serving it, so
// document.baseURI carries the mount point. Reading it here keeps one bundle working at the
// published URL, at the long canonical URL, and on the local dev server (where it is "/").
// Client routes need "siteType": "SPA" in config.json. createWebHashHistory() needs no base.
const base = new URL(document.baseURI).pathname

export const router = createRouter({
  history: createWebHistory(base),
  routes: [
    { path: '/', component: DashboardPage },
    // No login route: the platform's sign-in page handles that (see src/session.ts).
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
