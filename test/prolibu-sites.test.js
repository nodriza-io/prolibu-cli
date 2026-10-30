/* global describe, test, expect, beforeEach */
const fs = require('fs');
const path = require('path');
const session = require('../.claude/skills/prolibu-sites/assets/prolibu-session');

const ASSET = path.join(__dirname, '../.claude/skills/prolibu-sites/assets/prolibu-session.js');

let store;
let assigned;
let calls;
let replies;
let root;

function reply(status, body) {
  return { status, ok: status >= 200 && status < 300, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
}

beforeEach(() => {
  store = {};
  assigned = [];
  calls = [];
  replies = [];
  root = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null) },
    location: { pathname: '/site/my-site/deals', search: '?page=2', hash: '#top', assign: (url) => assigned.push(url) },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return replies.shift() || reply(200, {});
    },
  };
});

describe('token', () => {
  test('reads the V2 JSON-quoted form and the V1 plain form', () => {
    const s = session.create(root);
    store.apiKey = JSON.stringify('tok-v2');
    expect(s.token()).toBe('tok-v2');
    store.apiKey = 'tok-v1';
    expect(s.token()).toBe('tok-v1');
    store.apiKey = '12345';
    expect(s.token()).toBe('12345');
  });

  test('no session, or storage blocked, gives null', () => {
    expect(session.create(root).token()).toBeNull();
    root.localStorage = { getItem: () => { throw new Error('blocked'); } };
    expect(session.create(root).token()).toBeNull();
  });
});

describe('api', () => {
  test('sends the unquoted token as Bearer to the same origin', async () => {
    store.apiKey = JSON.stringify('tok-v2');
    replies.push(reply(200, { profile: { email: 'a@b.co' } }));
    const me = await session.create(root).me();
    expect(me.profile.email).toBe('a@b.co');
    expect(calls[0].url).toBe('/v2/user/me');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok-v2');
  });

  test('serializes an object body as JSON', async () => {
    store.apiKey = 'tok';
    await session.create(root).api('/endpoint/post/orders-push', { method: 'POST', body: { a: 1 } });
    expect(calls[0].init.body).toBe('{"a":1}');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
  });

  test('without a token it goes to the sign-in page with a relative redirect, and calls nothing', async () => {
    await expect(session.create(root).api('/user/me')).rejects.toMatchObject({ signingIn: true });
    expect(calls).toHaveLength(0);
    expect(assigned).toEqual(['/v2/auth/signin?redirect=%2Fsite%2Fmy-site%2Fdeals%3Fpage%3D2%23top']);
  });

  test('off the platform (a local dev server) it never redirects', async () => {
    root.location.pathname = '/';
    await expect(session.create(root).api('/user/me')).rejects.toMatchObject({ noSession: true });
    expect(assigned).toHaveLength(0);
  });

  test('on 401 it goes to sign in and leaves the stored token alone', async () => {
    store.apiKey = 'expired';
    replies.push(reply(401, { statusCode: 401, error: 'Unauthorized' }));
    await expect(session.create(root).api('/user/me')).rejects.toMatchObject({ signingIn: true });
    expect(store.apiKey).toBe('expired');
    expect(assigned).toHaveLength(1);
  });

  test('other errors carry the status and the server message', async () => {
    store.apiKey = 'tok';
    replies.push(reply(400, { statusCode: 400, error: 'Invalid JSON' }));
    await expect(session.create(root).api('/x')).rejects.toMatchObject({ status: 400, message: 'Invalid JSON' });
  });
});

test('the helper passes the cloud-drive content scanner', () => {
  // Same patterns the server rejects in uploaded text files when the scanner is on.
  const text = fs.readFileSync(ASSET, 'utf8');
  const patterns = [/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/i, /javascript:/i, /vbscript:/i, /onload\s*=/i,
    /onerror\s*=/i, /onclick\s*=/i, /<iframe\b/i, /<object\b/i, /<embed\b/i, /eval\s*\(/i, /document\.write/i];
  for (const p of patterns) expect(p.test(text)).toBe(false);
});
