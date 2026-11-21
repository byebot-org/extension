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

async function request(path, body, token, method = 'POST') {
  const res = await fetch(API_BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function lookup(ids = [], videos = []) {
  const labels = {};
  const vids = {};
  const stats = {};
  const batches = Math.max(Math.ceil(ids.length / MAX_BATCH), Math.ceil(videos.length / MAX_BATCH));
  for (let b = 0; b < batches; b++) {
    const { status, data } = await request('/v1/lookup', {
      ids: ids.slice(b * MAX_BATCH, (b + 1) * MAX_BATCH),
      videos: videos.slice(b * MAX_BATCH, (b + 1) * MAX_BATCH),
    });
    if (status === 200) { Object.assign(labels, data.labels); Object.assign(vids, data.videos); Object.assign(stats, data.stats); }
  }
  return { labels, videos: vids, stats };
}

// Authenticated call; a 401 drops the stored session.
async function authed(path, body, method) {
  const session = await getSession();
  if (!session) return { error: 'not_signed_in' };
  const { status, data } = await request(path, body, session.token, method);
  if (status === 401) {
    await api.storage.local.remove('session');
    return { error: 'not_signed_in' };
  }
  return status === 200 ? data : { error: data.error ?? 'failed' };
}

const report = (videoId, verdict, reasons) => authed('/v1/reports', { videoId, verdict, reasons });
async function videoStats(videoId) {
  const { status, data } = await request(`/v1/videos/${encodeURIComponent(videoId)}`, undefined, undefined, 'GET');
  return status === 200 ? data : { error: 'failed' };
}
const myVote = (videoId) => authed(`/v1/reports/mine?videoId=${encodeURIComponent(videoId)}`, undefined, 'GET');
const withdraw = (videoId) => authed(`/v1/reports?videoId=${encodeURIComponent(videoId)}`, undefined, 'DELETE');

const handlers = {
  lookup: (m) => lookup(m.ids, m.videos),
  report: (m) => report(m.videoId, m.verdict, m.reasons),
  videoStats: (m) => videoStats(m.videoId),
  myVote: (m) => myVote(m.videoId),
  withdraw: (m) => withdraw(m.videoId),
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
