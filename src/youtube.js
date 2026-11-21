// Content script for YouTube: looks up channels shown on the page in one batch,
// hides/marks the ones the community flagged as bots, and lets signed-in users report.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const { t, detectLang } = globalThis.ByeBotI18n;

  const CARD_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'yt-lockup-view-model',
  ].join(',');
  const CHANNEL_LINK = 'a[href^="/@"], a[href^="/channel/UC"]';
  const CACHE_TTL = 5 * 60 * 1000;
  const REASONS = ['ai_video', 'ai_voice', 'ai_thumbnail', 'ai_script', 'ai_images', 'mass_produced', 'other'];

  /** channel id -> { label: 'bot'|'unknown', ts }  (flagged because of its share of AI videos) */
  const chCache = new Map();
  /** video id -> { label: 'bot'|'human'|'unknown', ts } */
  const vidCache = new Map();
  /** video id -> { verdict, reasons } | null  (the signed-in user's own vote) */
  const myVotes = new Map();
  const pending = new Set();
  const shownAnyway = new Set(); // video ids (or channel ids if no video id) the user revealed this session
  let mode = 'hide'; // 'hide' | 'mark' | 'off'
  let scanTimer = null;

  // Use YouTube's UI language, which is what the user is reading.
  const tr = (key, vars) => t(key, detectLang(document.documentElement.lang || navigator.language), vars);
  const send = (msg) =>
    Promise.resolve(api.runtime.sendMessage(msg)).catch(() => ({ error: 'extension_unavailable' }));

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function toast(msg) {
    document.getElementById('byebot-toast')?.remove();
    const e = el('div', '', msg);
    e.id = 'byebot-toast';
    document.body.append(e);
    setTimeout(() => e.remove(), 3500);
  }

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

  function videoFromHref(href) {
    let u;
    try { u = new URL(href, location.origin); } catch { return null; }
    const id = u.pathname === '/watch' ? u.searchParams.get('v') : u.pathname.startsWith('/shorts/') ? u.pathname.split('/')[2] : null;
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  }

  /** Channel and video identified by a card (either may be missing). */
  function cardInfo(card) {
    let channelId = null;
    for (const a of card.querySelectorAll(CHANNEL_LINK)) {
      channelId = idFromHref(a.getAttribute('href'));
      if (channelId) break;
    }
    let videoId = null;
    for (const a of card.querySelectorAll('a[href^="/watch?v="], a[href^="/shorts/"]')) {
      videoId = videoFromHref(a.getAttribute('href'));
      if (videoId) break;
    }
    return { channelId, videoId };
  }

  // ---- voting -----------------------------------------------------------
  async function requireSignIn() {
    const { signedIn } = await send({ type: 'getState' });
    if (signedIn) return true;
    toast(tr('signInToReport'));
    await send({ type: 'openLogin' });
    return false;
  }

  function afterVoteChange(videoId, channelId, res) {
    vidCache.set(videoId, { label: res.label, ts: Date.now() });
    if (channelId) chCache.set(channelId, { label: res.channelLabel, ts: Date.now() });
    if (myVotes.get(videoId)?.verdict === 'human') shownAnyway.add(videoId);
    else shownAnyway.delete(videoId);
    document.querySelectorAll('[data-byebot-id]').forEach(clearCard);
    scheduleScan(true);
    updateBar();
  }

  function fail(res) {
    if (res?.error === 'not_signed_in') { toast(tr('signInToReport')); send({ type: 'openLogin' }); }
    else toast(tr(res?.error === 'rate_limited' ? 'rateLimited' : 'failed'));
    return false;
  }

  async function submitVote(videoId, channelId, verdict, reasons = []) {
    const res = await send({ type: 'report', videoId, verdict, reasons });
    if (res?.error) return fail(res);
    myVotes.set(videoId, { verdict, reasons });
    afterVoteChange(videoId, channelId, res);
    toast(tr('thanks'));
    return true;
  }

  async function withdrawVote(videoId, channelId) {
    const res = await send({ type: 'withdraw', videoId });
    if (res?.error) return fail(res);
    myVotes.set(videoId, null);
    afterVoteChange(videoId, channelId, res);
    toast(tr('removed'));
    return true;
  }

  // ---- report dialog (YouTube-style modal) ------------------------------
  function closeDialog() {
    document.getElementById('byebot-overlay')?.remove();
    document.removeEventListener('keydown', onDialogKey, true);
  }
  function onDialogKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); closeDialog(); }
  }

  function openReportDialog(videoId, channelId, selectedReasons, hasReport) {
    closeDialog();
    const selected = new Set(selectedReasons);

    const overlay = el('div');
    overlay.id = 'byebot-overlay';
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeDialog(); });
    // Keep YouTube's global hotkeys (space, k, f...) from firing while the dialog is open.
    overlay.addEventListener('keydown', (e) => e.stopPropagation());

    const dlg = el('div');
    dlg.id = 'byebot-dialog';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');

    const title = el('h2', '', tr('dialogTitle'));
    const sub = el('p', 'byebot-sub', tr('dialogSub'));
    const list = el('div', 'byebot-reasons');

    const submit = el('button', 'byebot-btn byebot-primary', hasReport ? tr('save') : tr('submit'));
    submit.disabled = selected.size === 0;

    for (const code of REASONS) {
      const row = el('label', 'byebot-reason');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = selected.has(code);
      box.onchange = () => {
        box.checked ? selected.add(code) : selected.delete(code);
        submit.disabled = selected.size === 0;
      };
      row.append(box, el('span', '', tr(code)));
      list.append(row);
    }

    const footer = el('div', 'byebot-footer');
    if (hasReport) {
      const remove = el('button', 'byebot-btn byebot-danger', tr('remove'));
      remove.onclick = async () => { remove.disabled = true; if (await withdrawVote(videoId, channelId)) closeDialog(); else remove.disabled = false; };
      footer.append(remove);
    }
    footer.append(el('span', 'byebot-spacer'));
    const cancel = el('button', 'byebot-btn', tr('cancel'));
    cancel.onclick = closeDialog;
    submit.onclick = async () => {
      submit.disabled = true;
      if (await submitVote(videoId, channelId, 'bot', [...selected])) closeDialog(); else submit.disabled = false;
    };
    footer.append(cancel, submit);

    dlg.append(title, sub, list, footer);
    overlay.append(dlg);
    document.body.append(overlay);
    document.addEventListener('keydown', onDialogKey, true);
    list.querySelector('input')?.focus();
  }

  // ---- card state -------------------------------------------------------
  function clearCard(card) {
    card._byebotPlaceholder?.remove();
    card._byebotPlaceholder = null;
    card.classList.remove('byebot-hidden', 'byebot-marked');
    card.removeAttribute('data-byebot-label');
  }

  /** Hidden when its video is judged AI, or its channel is flagged and the video isn't judged human. */
  function isFlagged({ channelId, videoId }) {
    const v = videoId ? vidCache.get(videoId)?.label : undefined;
    if (v === 'bot') return true;
    if (v === 'human') return false;
    return !!channelId && chCache.get(channelId)?.label === 'bot';
  }

  function applyCard(card, info) {
    const { channelId, videoId } = info;
    const reveal = videoId ?? channelId;
    const flagged = mode !== 'off' && isFlagged(info) && !shownAnyway.has(reveal);
    if (!flagged) {
      if (card.dataset.byebotLabel) clearCard(card);
      return;
    }
    if (card.dataset.byebotLabel === mode) return; // already applied
    clearCard(card);
    card.dataset.byebotLabel = mode;
    if (mode === 'mark') {
      card.classList.add('byebot-marked');
      card.title = tr('flagged');
      return;
    }
    card.classList.add('byebot-hidden');
    const ph = el('div', 'byebot-placeholder');
    const name = channelId?.startsWith('@') ? channelId : tr('aFlaggedChannel');
    const text = el('span', '', tr('hiddenFrom', { name }));
    const show = el('button', '', tr('show'));
    show.onclick = () => { shownAnyway.add(reveal); scheduleScan(true); };
    ph.append(text, show);
    if (videoId) {
      const human = el('button', '', tr('isHuman'));
      human.onclick = async () => {
        human.disabled = true;
        if (await requireSignIn()) await submitVote(videoId, channelId, 'human');
        human.disabled = false;
      };
      ph.append(human);
    }
    card.before(ph);
    card._byebotPlaceholder = ph;
  }

  // ---- scanning ---------------------------------------------------------
  function scan() {
    const wantCh = new Set();
    const wantVid = new Set();
    const fresh = (e) => e && Date.now() - e.ts < CACHE_TTL;
    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
      if (card.parentElement?.closest('[data-byebot-id]')) continue; // nested lockup
      const info = cardInfo(card);
      if (!info.channelId && !info.videoId) continue;
      const key = `${info.channelId ?? ''}|${info.videoId ?? ''}`;
      if (card.dataset.byebotId !== key) { // new card or YouTube recycled the element
        clearCard(card);
        card.dataset.byebotId = key;
      }
      if (info.channelId && !fresh(chCache.get(info.channelId)) && !pending.has('c:' + info.channelId)) wantCh.add(info.channelId);
      if (info.videoId && !fresh(vidCache.get(info.videoId)) && !pending.has('v:' + info.videoId)) wantVid.add(info.videoId);
      applyCard(card, info);
    }
    const ids = [...wantCh];
    const videos = [...wantVid];
    if (mode !== 'off' && (ids.length || videos.length)) {
      ids.forEach((i) => pending.add('c:' + i));
      videos.forEach((i) => pending.add('v:' + i));
      send({ type: 'lookup', ids, videos }).then((res) => {
        ids.forEach((i) => pending.delete('c:' + i));
        videos.forEach((i) => pending.delete('v:' + i));
        if (!res?.labels) return;
        const ts = Date.now();
        for (const i of ids) chCache.set(i, { label: res.labels[i] ?? 'unknown', ts });
        for (const i of videos) vidCache.set(i, { label: res.videos?.[i] ?? 'unknown', ts });
        scheduleScan();
      });
    }
    renderReportBar();
  }

  function scheduleScan(immediate) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, immediate ? 0 : 300);
  }

  // ---- report bar on /watch, next to the Subscribe button ---------------
  function updateBar() {
    const bar = document.getElementById('byebot-bar');
    if (!bar) return;
    const vote = myVotes.get(bar.dataset.video);
    const reportBtn = bar.querySelector('.byebot-report');
    const humanBtn = bar.querySelector('.byebot-safe');
    const reported = vote?.verdict === 'bot';
    const human = vote?.verdict === 'human';
    reportBtn.textContent = reported ? `✓ ${tr('reported')}` : tr('report');
    reportBtn.title = reported ? tr('editHint') : tr('reportHint');
    reportBtn.classList.toggle('byebot-selected', reported);
    humanBtn.textContent = human ? `✓ ${tr('human')}` : tr('human');
    humanBtn.title = human ? tr('undoHint') : tr('humanHint');
    humanBtn.classList.toggle('byebot-selected', human);
  }

  async function loadMyVote(videoId) {
    if (myVotes.has(videoId)) return;
    const res = await send({ type: 'myVote', videoId });
    if (!res?.error) { myVotes.set(videoId, res.vote); updateBar(); }
  }

  function renderReportBar() {
    const old = document.getElementById('byebot-bar');
    if (location.pathname !== '/watch') return old?.remove();
    const videoId = new URLSearchParams(location.search).get('v');
    const owner = document.querySelector('ytd-watch-metadata #owner') ?? document.querySelector('#owner');
    const link = owner?.querySelector('ytd-channel-name a');
    const channelId = link ? idFromHref(link.getAttribute('href')) : null;
    if (!owner || !videoId || !/^[\w-]{11}$/.test(videoId)) return old?.remove();

    // Sit right after the Subscribe button's container so both share the same row.
    const sub = owner.querySelector('#subscribe-button') ?? document.querySelector('ytd-watch-metadata #subscribe-button');
    if (old?.isConnected && old.dataset.video === videoId && (!sub || old.previousElementSibling === sub)) return;
    old?.remove();

    const bar = el('div');
    bar.id = 'byebot-bar';
    bar.dataset.video = videoId;
    const report = el('button', 'byebot-report');
    const human = el('button', 'byebot-safe');

    report.onclick = async () => {
      if (!(await requireSignIn())) return;
      const v = myVotes.get(videoId);
      const isBot = v?.verdict === 'bot';
      openReportDialog(videoId, channelId, isBot ? v.reasons : [], isBot);
    };
    human.onclick = async () => {
      if (!(await requireSignIn())) return;
      human.disabled = true;
      await (myVotes.get(videoId)?.verdict === 'human' ? withdrawVote(videoId, channelId) : submitVote(videoId, channelId, 'human'));
      human.disabled = false;
    };

    bar.append(report, human);
    sub ? sub.after(bar) : owner.append(bar);
    updateBar();
    loadMyVote(videoId);
  }

  // ---- init -------------------------------------------------------------
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.mode) {
      mode = changes.mode.newValue ?? 'hide';
      document.querySelectorAll('[data-byebot-id]').forEach(clearCard);
      scheduleScan(true);
    }
    if (changes.session) { // signed in or out: votes belong to the previous session
      myVotes.clear();
      document.getElementById('byebot-bar')?.remove();
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
