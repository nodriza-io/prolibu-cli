/* eslint-env browser */
/* global ProlibuSession */

// The page runs on the account's own domain (https://<domain>/site/<siteCode>/), the same origin
// as the app, so it uses the session the app already has: prolibu-session.js reads
// localStorage.apiKey and calls /v2 with it. Without a session (or on a 401) the helper sends the
// visitor to the platform's sign-in page (/v2/auth/signin), which handles password, SSO and MFA,
// and comes back here. Never build a password form, and never remove localStorage.apiKey: it is
// the app's session too.

(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);

    function showError(err) {
        // err.signingIn: the browser is already on its way to the sign-in page.
        if (err && err.signingIn) return;
        // err.noSession: opened outside the platform (a local dev server); there is no session here.
        $('error').textContent = err && err.noSession
            ? 'No Prolibu session here. Publish the site and open it at https://<domain>/site/<siteCode>/.'
            : 'Could not load: ' + ((err && err.message) || 'unknown error');
        $('error').hidden = false;
    }

    // Sign out of the platform (this ends the app's session too, since the site shares it), then
    // go to the sign-in page, which returns here.
    async function signOut() {
        $('signout').setAttribute('disabled', '');
        try {
            await ProlibuSession.api('/auth/signout', { method: 'DELETE' });
        } catch (err) {
            if (err && err.signingIn) return;
        }
        ProlibuSession.signIn();
    }

    async function init() {
        try {
            const me = await ProlibuSession.me();
            const profile = (me && me.profile) || {};
            const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || profile.email || 'unknown';
            $('who').textContent = 'Signed in as ' + name;
            $('signout').hidden = false;
            $('signout').addEventListener('click', signOut);

            // One small page of records: newest first by _id (indexed), only the fields shown.
            // For totals or many rows, read a Prolibu report instead (see HEAVY-READS.md).
            const query = new URLSearchParams({ limit: '5', sort: '-_id', select: 'dealName' });
            const result = await ProlibuSession.api('/deal?' + query);
            const deals = (result && result.data) || [];
            $('deals').replaceChildren(...deals.map((deal) =>
                Object.assign(document.createElement('co-list-item'), { label: deal.dealName || '(no name)', icon: 'briefcase' })));
            $('empty').hidden = deals.length > 0;
        } catch (err) {
            showError(err);
        } finally {
            $('loading').hidden = true;
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
