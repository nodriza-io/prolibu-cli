/* Prolibu session helper for pages hosted as a Prolibu Site (https://<domain>/site/<siteCode>/).
 *
 * The platform's sign-in page leaves the user's token in localStorage.apiKey on the account's
 * origin, which is the site's origin too. The V2 app stores it JSON-quoted and V1 stores it
 * plain, so both forms are read. The token never goes in a URL, and this helper never removes
 * it: on a 401 it sends the visitor to the sign-in page, which validates and cleans up itself.
 * Off the platform (a local dev server) there is no session: it throws instead of redirecting.
 *
 *   ProlibuSession.token()            the token, or null
 *   ProlibuSession.signIn()           go to the platform's sign-in page and come back here
 *   await ProlibuSession.api(path, init)   fetch('/v2' + path) with the token; JSON back
 *   await ProlibuSession.me()         the signed-in user (GET /v2/user/me)
 *
 * Load it with a classic <script src="prolibu-session.js"> before your own code; it defines
 * window.ProlibuSession. In a Vite app, put it in public/ and use src="./prolibu-session.js".
 * (module.exports is only for the repo's tests.)
 */
/* global window */
(function (global) {
  'use strict';

  function create(root) {
    function token() {
      var raw = null;
      try {
        raw = root.localStorage.getItem('apiKey');
      } catch {
        return null;
      }
      if (!raw) return null;
      try {
        var parsed = JSON.parse(raw);
        return typeof parsed === 'string' && parsed ? parsed : raw;
      } catch {
        return raw;
      }
    }

    function signIn() {
      var here = root.location.pathname + root.location.search + root.location.hash;
      root.location.assign('/v2/auth/signin?redirect=' + encodeURIComponent(here));
    }

    // Only a page served by the platform (/site/<code>/ or the long /sites/… form) shares the
    // app's origin. Anywhere else the sign-in page would not hand this page a session.
    function onPlatform() {
      return /^\/sites?\//.test(root.location.pathname);
    }

    function signingIn() {
      var err;
      if (!onPlatform()) {
        err = new Error('No Prolibu session here. Open the published site: https://<domain>/site/<siteCode>/');
        err.noSession = true;
        return err;
      }
      signIn();
      err = new Error('Redirecting to sign in');
      err.signingIn = true;
      return err;
    }

    async function api(path, init) {
      var options = init || {};
      var current = token();
      if (!current) throw signingIn();
      var headers = Object.assign({ Accept: 'application/json' }, options.headers || {});
      var body = options.body;
      if (body !== undefined && typeof body !== 'string') {
        body = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
      }
      headers.Authorization = 'Bearer ' + current;
      var res = await root.fetch('/v2' + path, Object.assign({}, options, { headers: headers, body: body }));
      if (res.status === 401) throw signingIn();
      var text = await res.text();
      var data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!res.ok) {
        var err = new Error((data && data.error) || ('Request failed with ' + res.status));
        err.status = res.status;
        err.body = data;
        throw err;
      }
      return data;
    }

    function me() {
      return api('/user/me');
    }

    return { token: token, signIn: signIn, api: api, me: me };
  }

  var session = create(global);
  session.create = create;
  if (typeof module !== 'undefined' && module.exports) module.exports = session;
  else global.ProlibuSession = session;
})(typeof window !== 'undefined' ? window : globalThis);
