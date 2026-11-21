const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const { t, detectLang } = globalThis.ByeBotI18n;
const lang = detectLang(api.i18n?.getUILanguage?.() ?? navigator.language);
const tr = (k) => t(k, lang);
document.querySelectorAll('[data-i18n]').forEach((e) => { e.textContent = tr(e.dataset.i18n); });
const send = (m) => Promise.resolve(api.runtime.sendMessage(m));

async function refresh() {
  const { signedIn, mode, shortsMode } = await send({ type: 'getState' });
  $('mode').value = mode;
  $('shortsMode').value = shortsMode;
  $('signin').hidden = signedIn;
  $('signout').hidden = !signedIn;
  $('danger').hidden = !signedIn;
  $('auth-text').textContent = tr(signedIn ? 'signedInText' : 'signinText');
}

$('signin').onclick = async () => { await send({ type: 'openLogin' }); window.close(); };
$('signout').onclick = async () => { await send({ type: 'signOut' }); refresh(); };
$('mode').onchange = (e) => api.storage.local.set({ mode: e.target.value });
$('shortsMode').onchange = (e) => api.storage.local.set({ shortsMode: e.target.value });
$('delete').onclick = async () => {
  if (!confirm(tr('deleteConfirm'))) return;
  await send({ type: 'deleteAccount' });
  refresh();
};
api.storage.onChanged.addListener(refresh);
refresh();
