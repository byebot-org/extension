const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const send = (m) => Promise.resolve(api.runtime.sendMessage(m));

async function refresh() {
  const { signedIn, mode } = await send({ type: 'getState' });
  $('mode').value = mode;
  $('signin').hidden = signedIn;
  $('signout').hidden = !signedIn;
  $('danger').hidden = !signedIn;
  $('auth-text').textContent = signedIn
    ? "You're signed in. Use the buttons on a video page to report channels."
    : 'Reading is anonymous. Sign in with Google to report bots.';
}

$('signin').onclick = async () => { await send({ type: 'openLogin' }); window.close(); };
$('signout').onclick = async () => { await send({ type: 'signOut' }); refresh(); };
$('mode').onchange = (e) => api.storage.local.set({ mode: e.target.value });
$('delete').onclick = async () => {
  if (!confirm('Delete your ByeBot account and all your reports? This cannot be undone.')) return;
  await send({ type: 'deleteAccount' });
  refresh();
};
api.storage.onChanged.addListener(refresh);
refresh();
