// Content script for YouTube: looks up channels shown on the page in one batch,
// hides/marks the ones the community flagged as bots, and lets signed-in users report.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;

  const CARD_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'yt-lockup-view-model',
  ].join(',');
  const CHANNEL_LINK = 'a[href^="/@"], a[href^="/channel/UC"]';
  const CACHE_TTL = 5 * 60 * 1000;

  /** id -> { label: 'bot'|'human'|'unknown', ts } */
  const cache = new Map();
  const pending = new Set();
  const shownAnyway = new Set(); // channels the user chose to reveal this session
  let mode = 'hide'; // 'hide' | 'mark' | 'off'
  let scanTimer = null;

  const send = (msg) =>
    Promise.resolve(api.runtime.sendMessage(msg)).catch(() => ({ error: 'extension_unavailable' }));

  function idFromHref(href) {
    let path;
    try { path = new URL(href, location.origin).pathname; } catch { return null; }
    const parts = path.split('/').filter(Boolean);
    try {
      if (parts[0]?.startsWith('@')) return decodeURIComponent(parts[0]).toLowerCase();
    } catch { return null; }
    if (parts[0] === 'channel' && /^UC[\w-]{22}$/.test(parts[1] ?? '')) return parts[1];
    return null;
  }

  function cardChannel(card) {
    for (const a of card.querySelectorAll(CHANNEL_LINK)) {
      const id = idFromHref(a.getAttribute('href'));
      if (id) return id;
    }
    return null;
  }

  // ---- card state -------------------------------------------------------
  function clearCard(card) {
    card._byebotPlaceholder?.remove();
    card._byebotPlaceholder = null;
    card.classList.remove('byebot-hidden', 'byebot-marked');
    card.removeAttribute('data-byebot-label');
  }

  function applyCard(card, id) {
    const entry = cache.get(id);
    const isBot = entry?.label === 'bot' && mode !== 'off' && !shownAnyway.has(id);
    if (!isBot) {
      if (card.dataset.byebotLabel) clearCard(card);
      return;
    }
    if (card.dataset.byebotLabel === mode) return; // already applied
    clearCard(card);
    card.dataset.byebotLabel = mode;
    if (mode === 'mark') {
      card.classList.add('byebot-marked');
      card.title = 'ByeBot: the community flagged this channel as a bot';
      return;
    }
    card.classList.add('byebot-hidden');
    const ph = document.createElement('div');
    ph.className = 'byebot-placeholder';
    const text = document.createElement('span');
    text.textContent = `ByeBot hid a video from ${id.startsWith('@') ? id : 'a flagged channel'}.`;
    const show = document.createElement('button');
    show.textContent = 'Show';
    show.onclick = () => { shownAnyway.add(id); scheduleScan(true); };
    const notBot = document.createElement('button');
    notBot.textContent = 'Not a bot';
    notBot.onclick = async () => { notBot.disabled = true; await submitReport(id, 'human', notBot); };
    ph.append(text, show, notBot);
    card.before(ph);
    card._byebotPlaceholder = ph;
  }

  // ---- scanning ---------------------------------------------------------
  function scan() {
    const toQuery = [];
    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
      if (card.parentElement?.closest('[data-byebot-id]')) continue; // nested lockup
      const id = cardChannel(card);
      if (!id) continue;
      if (card.dataset.byebotId !== id) { // new card or YouTube recycled the element
        clearCard(card);
        card.dataset.byebotId = id;
      }
      const entry = cache.get(id);
      if (entry && Date.now() - entry.ts < CACHE_TTL) applyCard(card, id);
      else if (!pending.has(id)) toQuery.push(id);
    }
    const ids = [...new Set(toQuery)];
    if (mode !== 'off' && ids.length) {
      ids.forEach((i) => pending.add(i));
      send({ type: 'lookup', ids }).then((res) => {
        ids.forEach((i) => pending.delete(i));
        if (!res?.labels) return;
        for (const i of ids) cache.set(i, { label: res.labels[i] ?? 'unknown', ts: Date.now() });
        scheduleScan();
      });
    }
    renderReportBar();
  }

  function scheduleScan(immediate) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, immediate ? 0 : 300);
  }

  // ---- reporting --------------------------------------------------------
  async function submitReport(id, verdict, feedbackEl) {
    const res = await send({ type: 'report', channelId: id, verdict });
    if (res?.error === 'not_signed_in') {
      if (feedbackEl) feedbackEl.textContent = 'Sign in to report…';
      await send({ type: 'openLogin' });
      if (feedbackEl) feedbackEl.disabled = false;
      return;
    }
    if (res?.error) {
      if (feedbackEl) { feedbackEl.textContent = res.error === 'rate_limited' ? 'Slow down' : 'Failed'; feedbackEl.disabled = false; }
      return;
    }
    cache.set(id, { label: res.label, ts: Date.now() });
    if (verdict === 'human') shownAnyway.add(id);
    document.querySelectorAll('[data-byebot-id]').forEach(clearCard);
    scheduleScan(true);
    if (feedbackEl?.isConnected) feedbackEl.textContent = 'Thanks!';
  }

  // Report bar on /watch pages, next to the channel owner row.
  function renderReportBar() {
    const bar = document.getElementById('byebot-bar');
    if (location.pathname !== '/watch') return bar?.remove();
    const owner = document.querySelector('#owner');
    const link = owner?.querySelector('ytd-channel-name a');
    const id = link && idFromHref(link.getAttribute('href'));
    if (!owner || !id) return bar?.remove();
    if (bar?.dataset.channel === id) return;
    bar?.remove();

    const el = document.createElement('div');
    el.id = 'byebot-bar';
    el.dataset.channel = id;
    const label = document.createElement('span');
    label.textContent = 'ByeBot:';
    const bot = document.createElement('button');
    bot.textContent = '🤖 Bot';
    bot.title = 'Report this channel as a bot / content farm';
    const human = document.createElement('button');
    human.textContent = '✓ Not a bot';
    for (const [btn, verdict] of [[bot, 'bot'], [human, 'human']]) {
      btn.onclick = async () => {
        bot.disabled = human.disabled = true;
        await submitReport(id, verdict, btn);
        bot.disabled = human.disabled = false;
      };
    }
    el.append(label, bot, human);
    owner.after(el);
  }

  // ---- init -------------------------------------------------------------
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.mode) {
      mode = changes.mode.newValue ?? 'hide';
      document.querySelectorAll('[data-byebot-id]').forEach(clearCard);
      scheduleScan(true);
    }
  });

  api.storage.local.get('mode').then(({ mode: m }) => {
    mode = m ?? 'hide';
    new MutationObserver(() => scheduleScan()).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('yt-navigate-finish', () => scheduleScan(true));
    scheduleScan(true);
  });
})();
