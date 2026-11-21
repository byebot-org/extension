// Runs on https://byebot.org/login. Relays the session token from the page to the extension.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== window.location.origin) return;
    const d = ev.data;
    if (!d || d.type !== 'byebot-auth') return;
    api.runtime.sendMessage({ type: 'authToken', token: d.token, expiresAt: d.expiresAt });
  });
})();
