# ByeBot extension (Chrome / Brave / Edge / Firefox, MV3)

Plain JS, no build step. Backend: `../backend` (Cloudflare Worker); sign-in page: `https://byebot.org/login`.

Chrome and Firefox need different `background` keys, so build per-browser bundles first:

```
node scripts/build.mjs
```

- **Chrome/Edge/Brave:** `chrome://extensions` → Developer mode → *Load unpacked* → `dist/chrome`
  (the root `manifest.json` is also Chrome-compatible, so loading the repo folder works too).
- **Firefox:** `about:debugging` → *This Firefox* → *Load Temporary Add-on* → `dist/firefox/manifest.json`.

Flow: popup/report button → opens `byebot.org/login` → Google button → backend returns a session
token → `src/login-bridge.js` relays it to the background script, which stores it in `storage.local`.
Change `API_BASE` in `src/background.js` if the backend URL changes.

## Automatic builds
`.github/workflows/build.yml` builds `byebot-chrome-<version>.zip` and `byebot-firefox-<version>.zip` on every push/PR
(download them from the run's *Artifacts*). Pushing a tag like `v0.1.0` (must match `manifest.json`'s version)
also publishes them in a GitHub Release.

- **Chrome/Edge/Brave:** unzip the Chrome zip → `chrome://extensions` → Developer mode → *Load unpacked*.
- **Firefox:** the zip is unsigned, so it only loads temporarily via `about:debugging`. A permanent install
  needs signing through addons.mozilla.org.
