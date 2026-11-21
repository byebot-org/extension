// Service worker / background script. Owns all network access and the session token.
const api = globalThis.browser ?? globalThis.chrome;

const API_BASE = 'https://byebot-backend.ronaldzav.workers.dev';
const LOGIN_URL = 'https://byebot.org/login?source=extension';
const MAX_BATCH = 100;

async function getSession() {
  const { session } = await api.storage.local.get('session');
  if (!session || session.expiresAt < Date.now() / 1000) {
    if (session) await api.storage.local.remove('session');
    return null;
  }
  return session;
}

async function request(path, body, token) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function lookup(ids) {
  const labels = {};
  for (let i = 0; i < ids.length; i += MAX_BATCH) {
    const { status, data } = await request('/v1/lookup', { ids: ids.slice(i, i + MAX_BATCH) });
    if (status === 200) Object.assign(labels, data.labels);
  }
  return { labels };
}

async function report(channelId, verdict) {
  const session = await getSession();
  if (!session) return { error: 'not_signed_in' };
  const { status, data } = await request('/v1/reports', { channelId, verdict }, session.token);
  if (status === 401) {
    await api.storage.local.remove('session');
    return { error: 'not_signed_in' };
  }
  return status === 200 ? data : { error: data.error ?? 'failed' };
}

const handlers = {
  lookup: (m) => lookup(m.ids),
  report: (m) => report(m.channelId, m.verdict),
  getState: async () => {
    const [session, { mode }] = await Promise.all([getSession(), api.storage.local.get('mode')]);
    return { signedIn: !!session, mode: mode ?? 'hide' };
  },
  openLogin: async () => { await api.tabs.create({ url: LOGIN_URL }); return {}; },
  signOut: async () => { await api.storage.local.remove('session'); return {}; },
  deleteAccount: async () => {
    const session = await getSession();
    if (!session) return { error: 'not_signed_in' };
    const res = await fetch(API_BASE + '/v1/me', { method: 'DELETE', headers: { Authorization: `Bearer ${session.token}` } });
    if (res.ok) await api.storage.local.remove('session');
    return res.ok ? {} : { error: 'failed' };
  },
  // Sent by login-bridge.js after byebot.org/login completes Google sign-in.
  authToken: async (m, sender) => {
    if (!sender.url || new URL(sender.url).origin !== 'https://byebot.org') return { error: 'forbidden' };
    if (typeof m.token !== 'string' || typeof m.expiresAt !== 'number') return { error: 'bad_payload' };
    await api.storage.local.set({ session: { token: m.token, expiresAt: m.expiresAt } });
    return {};
  },
};

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  h(msg, sender).then(sendResponse, () => sendResponse({ error: 'internal' }));
  return true; // async response
});
