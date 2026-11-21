# ByeBot extension (Chrome / Brave / Edge / Firefox, MV3)

Plain JS, no build step. Backend: `../backend` (Cloudflare Worker); sign-in page: `https://byebot.org/login`.

- **Chrome/Edge/Brave:** `chrome://extensions` → Developer mode → *Load unpacked* → this folder.
- **Firefox:** `about:debugging` → *This Firefox* → *Load Temporary Add-on* → `manifest.json`.

Flow: popup/report button → opens `byebot.org/login` → Google button → backend returns a session
token → `src/login-bridge.js` relays it to the background script, which stores it in `storage.local`.
Change `API_BASE` in `src/background.js` if the backend URL changes.
