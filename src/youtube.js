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
    'ytm-shorts-lockup-view-model',
    'ytd-reel-item-renderer',
  ].join(',');
  const THUMB_SELECTOR = 'yt-thumbnail-view-model, ytd-thumbnail, a#thumbnail';
  // Icons are built with createElementNS: YouTube enforces Trusted Types, so DOMParser/innerHTML throw.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgIcon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const add = (tag, attrs) => {
      const e = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      svg.append(e);
    };
    const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-width': '3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    if (name === 'human') {
      add('path', { d: 'M5 12.5l4.5 4.5L19 7.5', ...stroke });
    } else { // 'maybe' / report: exclamation mark
      add('path', { d: 'M12 7v6.5', ...stroke });
      add('circle', { cx: '12', cy: '17.2', r: '1.7', fill: 'currentColor' });
    }
    return svg;
  }
  const CHANNEL_LINK = 'a[href*="/@"], a[href*="/channel/UC"]';
  const VIDEO_LINK = 'a[href*="/watch?v="], a[href*="/shorts/"]';
  const CACHE_TTL = 5 * 60 * 1000;
  const REASONS = ['ai_video', 'ai_voice', 'ai_thumbnail', 'ai_script', 'ai_images', 'mass_produced', 'other'];

  /** channel id -> { label: 'bot'|'unknown', ts }  (flagged because of its share of AI videos) */
  const chCache = new Map();
  /** video id -> { label: 'bot'|'human'|'unknown', ts } */
  const vidCache = new Map();
  /** video id -> { verdict, reasons } | null  (the signed-in user's own vote) */
  const myVotes = new Map();
  /** video id -> { bot, human } vote counts (community tally) */
  const videoVotes = new Map();
  const pending = new Set();

  // Labels survive page loads, so badges can show instantly and then get revalidated.
  const CACHE_KEY = 'labelCache';
  const PERSIST_MAX_AGE = 24 * 60 * 60 * 1000;
  const PERSIST_MAX = 3000;
  let persistTimer = null;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const cut = Date.now() - PERSIST_MAX_AGE;
      const dump = (m) => Object.fromEntries(
        [...m].filter(([, e]) => e.ts > cut).slice(-PERSIST_MAX).map(([k, e]) => [k, [e.label, e.ts, e.stats]]),
      );
      if (!alive()) return shutdown();
      try {
        api.storage.local.set({ [CACHE_KEY]: { ch: dump(chCache), vid: dump(vidCache) } }).catch(() => {});
      } catch { shutdown(); }
    }, 1500);
  }
  const shownAnyway = new Set(); // video ids (or channel ids if no video id) the user revealed this session
  let mode = 'hide'; // regular videos: 'hide' | 'mark' | 'off'
  let shortsMode = 'mark'; // Shorts: 'skip' | 'mark' | 'off'
  let scanTimer = null;

  // Use YouTube's UI language, which is what the user is reading.
  const tr = (key, vars) => t(key, detectLang(document.documentElement.lang || navigator.language), vars);

  // When the extension is reloaded/updated, this content script is orphaned: every
  // chrome.* call throws "Extension context invalidated" (synchronously). Detect it and shut down quietly.
  let observer = null;
  let navHandler = null;
  const alive = () => {
    try { return !!api.runtime?.id; } catch { return false; }
  };
  function shutdown() {
    observer?.disconnect();
    if (navHandler) document.removeEventListener('yt-navigate-finish', navHandler);
    document.removeEventListener('click', onMenuOpenClick, true);
    clearTimeout(scanTimer);
    clearTimeout(persistTimer);
    scanTimer = persistTimer = null;
    document.querySelectorAll('[data-byebot-id]').forEach(clearCard);
    document.getElementById('byebot-bar')?.remove();
    document.getElementById('byebot-community')?.remove();
    document.getElementById('byebot-short')?.remove();
    document.getElementById('byebot-channel-banner')?.remove();
    closeDialog();
  }
  const isInvalidated = (e) => /Extension context invalidated/i.test(String(e?.message ?? e));
  window.addEventListener('unhandledrejection', (e) => {
    if (isInvalidated(e.reason)) { e.preventDefault(); shutdown(); }
  });
  window.addEventListener('error', (e) => {
    if (isInvalidated(e.error ?? e.message)) { e.preventDefault(); shutdown(); }
  });

  const send = (msg) => {
    if (!alive()) { shutdown(); return Promise.resolve({ error: 'extension_unavailable' }); }
    try {
      return Promise.resolve(api.runtime.sendMessage(msg)).catch((e) => {
        if (isInvalidated(e)) shutdown();
        return { error: 'extension_unavailable' };
      });
    } catch {
      shutdown();
      return Promise.resolve({ error: 'extension_unavailable' });
    }
  };

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
    let short = card.matches('ytm-shorts-lockup-view-model, ytd-reel-item-renderer');
    for (const a of card.querySelectorAll(VIDEO_LINK)) {
      videoId = videoFromHref(a.getAttribute('href'));
      if (videoId) { short = short || a.getAttribute('href').includes('/shorts/'); break; }
    }
    return { channelId, videoId, short };
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
    if (channelId) chCache.set(channelId, { label: res.channelLabel, ts: Date.now(), stats: res.channelStats ?? undefined });
    persist();
    if (res.votes) videoVotes.set(videoId, res.votes);
    if (myVotes.get(videoId)?.verdict === 'human') shownAnyway.add(videoId);
    else shownAnyway.delete(videoId);
    document.querySelectorAll('[data-byebot-id]').forEach(clearCard);
    scheduleScan(true);
    updateBar();
    updateCommunityBadge();
    refreshMenuItems();
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
    card.classList.remove('byebot-hidden');
    card.removeAttribute('data-byebot-label');
    removeBadge(card);
  }

  /** Shorts follow their own setting: skip -> hide the card, mark -> badge only, off -> nothing. */
  const effMode = (info) => (info.short ? { skip: 'hide', mark: 'mark', off: 'off' }[shortsMode] ?? 'mark' : mode);

  // ---- badge ------------------------------------------------------------
  /** 'human' = judged human, 'bot' = judged AI, 'maybe' = channel flagged but this video not judged yet. */
  function badgeState({ channelId, videoId }) {
    const v = videoId ? vidCache.get(videoId)?.label : undefined;
    if (v === 'human') return 'human';
    if (v === 'bot') return 'bot';
    return channelId && chCache.get(channelId)?.label === 'bot' ? 'maybe' : null;
  }

  function removeBadge(card) {
    card._byebotBadge?.remove();
    card._byebotBadge = null;
    card._byebotBadgeHost?.classList.remove('byebot-badge-host');
    card._byebotBadgeHost = null;
  }

  function setBadge(card, info) {
    const state = effMode(info) === 'off' ? null : badgeState(info);
    if (!state) return removeBadge(card);
    if (card._byebotBadge?.dataset.state === state && card._byebotBadge.isConnected) return;
    removeBadge(card);
    const host = card.querySelector(THUMB_SELECTOR) ?? card.querySelector('img')?.parentElement;
    if (!host) return;
    const badge = el('span', `byebot-badge byebot-badge-${state}`);
    badge.dataset.state = state;
    if (state === 'bot') {
      badge.textContent = 'IA'; // literal text, same in every language
    } else {
      badge.append(svgIcon(state));
    }
    badge.title = tr(state === 'human' ? 'badgeHuman' : state === 'bot' ? 'badgeBot' : 'badgeMaybe');
    host.classList.add('byebot-badge-host');
    host.append(badge);
    card._byebotBadge = badge;
    card._byebotBadgeHost = host;
  }

  /** Hidden when its video is judged AI, or its channel is flagged and the video isn't judged human. */
  function isFlagged({ channelId, videoId }) {
    const v = videoId ? vidCache.get(videoId)?.label : undefined;
    if (v === 'bot') return true;
    if (v === 'human') return false;
    return !!channelId && chCache.get(channelId)?.label === 'bot';
  }

  function applyCard(card, info) {
    applyHide(card, info);
    setBadge(card, info);
  }

  function applyHide(card, info) {
    const { channelId, videoId } = info;
    const eff = effMode(info);
    const reveal = videoId ?? channelId;
    const flagged = eff !== 'off' && isFlagged(info) && !shownAnyway.has(reveal);
    if (!flagged) {
      if (card.dataset.byebotLabel) clearCard(card);
      return;
    }
    if (card.dataset.byebotLabel === eff) return; // already applied
    clearCard(card);
    card.dataset.byebotLabel = eff;
    if (eff === 'mark') return; // "mark only": the badge is the marker
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
    if (!alive()) return shutdown();
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
    const shortId = shortsPageId();
    if (shortId) {
      const sc = reelChannel(activeReel());
      if (!fresh(vidCache.get(shortId)) && !pending.has('v:' + shortId)) wantVid.add(shortId);
      if (sc && !fresh(chCache.get(sc)) && !pending.has('c:' + sc)) wantCh.add(sc);
    }
    const pageCh = channelPageId();
    if (pageCh && !fresh(chCache.get(pageCh)) && !pending.has('c:' + pageCh)) wantCh.add(pageCh);
    const ids = [...wantCh];
    const videos = [...wantVid];
    if ((mode !== 'off' || shortsMode !== 'off') && (ids.length || videos.length)) {
      ids.forEach((i) => pending.add('c:' + i));
      videos.forEach((i) => pending.add('v:' + i));
      send({ type: 'lookup', ids, videos }).then((res) => {
        ids.forEach((i) => pending.delete('c:' + i));
        videos.forEach((i) => pending.delete('v:' + i));
        if (!res?.labels) return;
        const ts = Date.now();
        for (const i of ids) chCache.set(i, { label: res.labels[i] ?? 'unknown', ts, stats: res.stats?.[i] });
        for (const i of videos) vidCache.set(i, { label: res.videos?.[i] ?? 'unknown', ts });
        persist();
        scheduleScan(true);
      });
    }
    if (shortId) renderShortsUi();
    else renderReportBar();
    renderChannelBanner();
    injectMenuItems();
  }

  // Throttle (not debounce): YouTube mutates the DOM constantly while loading,
  // and a debounce would postpone scanning until it calms down.
  function scheduleScan(immediate) {
    if (immediate) {
      clearTimeout(scanTimer);
      scanTimer = null;
      scan();
      return;
    }
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 120);
  }

  // ---- banner on channel pages ------------------------------------------
  /** Channel id when the current page is a channel page (/@handle, /channel/UC...). */
  function channelPageId() {
    return /^\/(@[^/]+|channel\/UC[\w-]{22})(\/|$)/.test(location.pathname) ? idFromHref(location.pathname) : null;
  }

  // Match the width/position of the channel's own banner image so we never overflow the page.
  // Ordered by preference. (A comma-joined querySelector would return the first match in
  // document order, which can be a full-width ancestor like #page-header-banner.)
  const CHANNEL_BANNER_REFS = ['yt-page-header-renderer', 'yt-image-banner-view-model', 'ytd-c4-tabbed-header-renderer #banner'];
  function alignChannelBanner(banner) {
    banner.style.width = '';
    banner.style.marginLeft = '';
    banner.style.marginRight = '';
    let ref = null;
    for (const sel of CHANNEL_BANNER_REFS) {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      if (r && r.width >= 120) { ref = r; break; }
    }
    if (!ref) return; // fall back to the CSS default
    banner.style.width = `${Math.min(ref.width, document.documentElement.clientWidth)}px`;
    banner.style.marginLeft = '0px';
    banner.style.marginRight = '0px';
    const own = banner.getBoundingClientRect();
    banner.style.marginLeft = `${Math.max(0, ref.left - own.left)}px`;
  }
  window.addEventListener('resize', () => {
    const b = document.getElementById('byebot-channel-banner');
    if (b) alignChannelBanner(b);
  });

  function renderChannelBanner() {
    const old = document.getElementById('byebot-channel-banner');
    const id = channelPageId();
    const entry = id && chCache.get(id);
    if (!id || mode === 'off' || entry?.label !== 'bot') return old?.remove();

    const stats = entry.stats;
    const total = stats ? stats.bot + stats.human : 0;
    const sig = `${id}|${stats?.bot}|${stats?.human}|${document.documentElement.lang}`;
    const anchor = document.querySelector('yt-page-header-renderer, ytd-c4-tabbed-header-renderer, #page-header, #channel-header');
    if (!anchor) return old?.remove();
    if (old?.isConnected && old.dataset.sig === sig && old.previousElementSibling === anchor) {
      alignChannelBanner(old);
      return;
    }
    old?.remove();

    const banner = el('div');
    banner.id = 'byebot-channel-banner';
    banner.dataset.sig = sig;
    banner.setAttribute('role', 'status');
    const icon = el('span', 'byebot-badge-bot byebot-banner-icon', 'IA');
    const text = el('div', 'byebot-banner-text');
    text.append(el('strong', '', tr('channelBanner')));
    if (total > 0) {
      const pct = Math.round((stats.bot / total) * 100);
      text.append(el('span', '', tr('channelBannerStats', { pct, bot: stats.bot, total })));
    }
    banner.append(icon, text);
    anchor.after(banner);
    alignChannelBanner(banner);
  }

  // ---- report bar on /watch, next to the Subscribe button ---------------
  function updateBar() {
    updateShortButtons();
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

  /** "X% of the community says it's human / AI", from the public vote tally. */
  // Own line under the channel row, so it never squeezes YouTube's like/share buttons.
  function communityRow(create) {
    let row = document.getElementById('byebot-community');
    if (!row && create) {
      const anchor = document.querySelector('ytd-watch-metadata #top-row') ?? document.querySelector('#owner');
      if (!anchor) return null;
      row = el('div');
      row.id = 'byebot-community';
      anchor.after(row);
    }
    return row;
  }

  function updateCommunityBadge() {
    if (document.getElementById('byebot-short')) return updateShortButtons();
    const bar = document.getElementById('byebot-bar');
    if (!bar) return communityRow(false)?.remove();
    const votes = videoVotes.get(bar.dataset.video);
    const total = votes ? votes.bot + votes.human : 0;
    if (!votes || total === 0 || votes.bot === votes.human) return communityRow(false)?.remove(); // no votes or a tie: nothing to claim
    const ai = votes.bot > votes.human;
    const pct = Math.round((Math.max(votes.bot, votes.human) / total) * 100);
    const row = communityRow(true);
    if (!row) return;
    row.dataset.video = bar.dataset.video;
    const pill = el('span', `byebot-community byebot-community-${ai ? 'ai' : 'human'}`);
    pill.append(
      el('span', 'byebot-community-dot', ai ? 'IA' : '✓'),
      el('span', '', `${tr(ai ? 'communityAi' : 'communityHuman', { pct })} · ${tr(total === 1 ? 'communityVote' : 'communityVotes', { n: total })}`),
    );
    row.replaceChildren(pill);
  }

  async function loadVideoStats(videoId) {
    const res = await send({ type: 'videoStats', videoId });
    if (res && !res.error) { videoVotes.set(videoId, { bot: res.bot, human: res.human }); updateCommunityBadge(); }
  }

  async function loadMyVote(videoId) {
    if (myVotes.has(videoId)) return;
    const res = await send({ type: 'myVote', videoId });
    if (!res?.error) { myVotes.set(videoId, res.vote); updateBar(); }
  }

  async function onReportClick(videoId, getChannel) {
    if (!(await requireSignIn())) return;
    const v = myVotes.get(videoId);
    const isBot = v?.verdict === 'bot';
    openReportDialog(videoId, getChannel(), isBot ? v.reasons : [], isBot);
  }

  async function onHumanClick(videoId, getChannel, btn) {
    if (!(await requireSignIn())) return;
    btn.disabled = true;
    await (myVotes.get(videoId)?.verdict === 'human' ? withdrawVote(videoId, getChannel()) : submitVote(videoId, getChannel(), 'human'));
    btn.disabled = false;
  }

  /** Report / Human buttons for a video on watch pages. */
  function makeBar(videoId, getChannel) {
    const bar = el('div');
    bar.id = 'byebot-bar';
    bar.dataset.video = videoId;
    const report = el('button', 'byebot-report');
    const human = el('button', 'byebot-safe');

    report.onclick = () => onReportClick(videoId, getChannel);
    human.onclick = () => onHumanClick(videoId, getChannel, human);

    bar.append(report, human);
    return bar;
  }

  // ---- Shorts player ----------------------------------------------------
  const shortsPageId = () => location.pathname.match(/^\/shorts\/([\w-]{11})/)?.[1] ?? null;
  const activeReel = () => document.querySelector('ytd-reel-video-renderer[is-active]') ?? document.querySelector('ytd-reel-video-renderer');
  function reelChannel(reel) {
    const a = reel?.querySelector('yt-reel-channel-bar-view-model a[href*="/@"], a[href*="/@"]');
    return a ? idFromHref(a.getAttribute('href')) : null;
  }

  let lastShort = null;
  let lastLastShort = null;
  let shortDir = 'down'; // which way the user is scrolling, so skipping never traps them
  let skippedFor = null;

  function maybeSkipShort(videoId, channelId) {
    if (shortsMode !== 'skip' || skippedFor === videoId || shownAnyway.has(videoId)) return;
    if (!isFlagged({ channelId, videoId })) return;
    const btn = document.querySelector(shortDir === 'up' ? '#navigation-button-up button' : '#navigation-button-down button');
    if (!btn) return; // nothing to skip to (yet)
    skippedFor = videoId;
    btn.click();
    toast(tr('shortsSkipped'));
  }


  /** Two round buttons that sit right above the Like button in the Shorts action column. */
  function makeShortButtons(videoId, getChannel) {
    const box = el('div');
    box.id = 'byebot-short';
    box.dataset.video = videoId;
    const item = (kind, icon, onClick) => {
      const wrap = el('div', `byebot-short-item byebot-short-item-${kind}`);
      const btn = el('button', `byebot-short-btn byebot-short-${kind}`);
      btn.type = 'button';
      btn.append(svgIcon(icon));
      if (kind === 'report') btn.append(el('span', 'byebot-short-pip'));
      btn.onclick = onClick;
      wrap.append(btn, el('span', 'byebot-short-label'));
      return wrap;
    };
    let humanBtn = null;
    const reportItem = item('report', 'maybe', () => onReportClick(videoId, getChannel));
    const humanItem = item('human', 'human', () => onHumanClick(videoId, getChannel, humanBtn));
    humanBtn = humanItem.querySelector('button');
    box.append(reportItem, humanItem);
    return box;
  }

  function updateShortButtons() {
    const box = document.getElementById('byebot-short');
    if (!box) return;
    const id = box.dataset.video;
    const vote = myVotes.get(id);
    const votes = videoVotes.get(id);
    const total = votes ? votes.bot + votes.human : 0;
    const report = box.querySelector('.byebot-short-report');
    const human = box.querySelector('.byebot-short-human');
    report.classList.toggle('byebot-selected', vote?.verdict === 'bot');
    human.classList.toggle('byebot-selected', vote?.verdict === 'human');

    // Full community sentence goes in the tooltips; counts go under the buttons like YouTube's Like count.
    let community = '';
    if (total > 0 && votes.bot !== votes.human) {
      const ai = votes.bot > votes.human;
      const pct = Math.round((Math.max(votes.bot, votes.human) / total) * 100);
      community = `${tr(ai ? 'communityAi' : 'communityHuman', { pct })} · ${tr(total === 1 ? 'communityVote' : 'communityVotes', { n: total })}`;
    }
    const tip = (base) => (community ? `${base}\n${community}` : base);
    report.title = tip(vote?.verdict === 'bot' ? tr('editHint') : tr('reportHint'));
    human.title = tip(vote?.verdict === 'human' ? tr('undoHint') : tr('humanHint'));
    box.querySelector('.byebot-short-item-report .byebot-short-label').textContent = total > 0 ? String(votes.bot) : '';
    box.querySelector('.byebot-short-item-human .byebot-short-label').textContent = total > 0 ? String(votes.human) : '';

    // Small pip on the report button: the overall verdict (IA / human / possibly AI).
    const pip = report.querySelector('.byebot-short-pip');
    const state = shortsMode === 'off' ? null : badgeState({ channelId: reelChannel(activeReel()), videoId: id });
    pip.className = state ? `byebot-short-pip byebot-badge-${state}` : 'byebot-short-pip';
    pip.textContent = state === 'bot' ? 'IA' : state === 'human' ? '✓' : state === 'maybe' ? '!' : '';
    if (state) report.title += `\n${tr(state === 'human' ? 'badgeHuman' : state === 'bot' ? 'badgeBot' : 'badgeMaybe')}`;
  }

  function renderShortsUi() {
    const videoId = shortsPageId();
    const reel = activeReel();
    if (!videoId || !reel) return removeBar();
    if (videoId !== lastShort) {
      shortDir = videoId === lastLastShort ? 'up' : 'down';
      lastLastShort = lastShort;
      lastShort = videoId;
    }
    maybeSkipShort(videoId, reelChannel(reel));

    const old = document.getElementById('byebot-short');
    if (old?.isConnected && old.dataset.video === videoId && reel.contains(old)) return updateShortButtons();
    removeBar();
    const like = reel.querySelector('like-button-view-model, #like-button');
    if (!like) return; // action bar not rendered yet; a later scan will retry
    like.before(makeShortButtons(videoId, () => reelChannel(activeReel())));
    updateShortButtons();
    loadMyVote(videoId);
    loadVideoStats(videoId);
  }

  function removeBar() {
    document.getElementById('byebot-bar')?.remove();
    document.getElementById('byebot-community')?.remove();
    document.getElementById('byebot-short')?.remove();
  }

  function renderReportBar() {
    const old = document.getElementById('byebot-bar');
    if (location.pathname !== '/watch') return removeBar();
    const videoId = new URLSearchParams(location.search).get('v');
    const owner = document.querySelector('ytd-watch-metadata #owner') ?? document.querySelector('#owner');
    const link = owner?.querySelector('ytd-channel-name a');
    const channelId = link ? idFromHref(link.getAttribute('href')) : null;
    if (!owner || !videoId || !/^[\w-]{11}$/.test(videoId)) return removeBar();

    // Sit right after the Subscribe button's container so both share the same row.
    const sub = owner.querySelector('#subscribe-button') ?? document.querySelector('ytd-watch-metadata #subscribe-button');
    if (old?.isConnected && old.dataset.video === videoId && (!sub || old.previousElementSibling === sub)) return;
    removeBar();

    const bar = makeBar(videoId, () => channelId);
    sub ? sub.after(bar) : owner.append(bar);
    updateBar();
    updateCommunityBadge();
    loadMyVote(videoId);
    loadVideoStats(videoId);
  }

  // ---- three-dot menu: add "Report" / "Human" -----------------------------
  const MENU_BTN = '.ytLockupMetadataViewModelMenuButton button, ytd-menu-renderer button, ytd-menu-renderer yt-icon-button';
  const MENU_LISTS = 'yt-list-view-model, tp-yt-paper-listbox#items, ytd-menu-popup-renderer #items';
  let menuTarget = null; // { videoId, channelId, ts } of the video whose menu was just opened

  function onMenuOpenClick(e) {
    if (!alive()) return shutdown();
    const btn = e.target?.closest?.(MENU_BTN);
    if (!btn) return;
    const card = btn.closest(CARD_SELECTOR);
    let target = null;
    if (card) {
      const info = cardInfo(card);
      target = { videoId: info.videoId, channelId: info.channelId };
    } else if (btn.closest('ytd-watch-metadata') && location.pathname === '/watch') {
      const link = document.querySelector('ytd-watch-metadata #owner ytd-channel-name a');
      target = { videoId: new URLSearchParams(location.search).get('v'), channelId: link ? idFromHref(link.getAttribute('href')) : null };
    } else if (btn.closest('ytd-reel-video-renderer')) {
      target = { videoId: shortsPageId(), channelId: reelChannel(activeReel()) };
    }
    menuTarget = target?.videoId ? { ...target, ts: Date.now() } : null;
  }
  document.addEventListener('click', onMenuOpenClick, true);

  function closeMenu() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
  }

  function menuLabels(videoId) {
    const v = myVotes.get(videoId)?.verdict;
    return {
      report: v === 'bot' ? `✓ ${tr('reported')}` : tr('report'),
      human: v === 'human' ? `✓ ${tr('human')}` : tr('human'),
    };
  }

  function refreshMenuItems() {
    for (const row of document.querySelectorAll('.byebot-menu-item')) {
      row.querySelector('span').textContent = menuLabels(row.dataset.video)[row.dataset.kind];
    }
  }

  function makeMenuItem(kind, target) {
    const row = el('div', `byebot-menu-item byebot-menu-${kind}`);
    row.dataset.kind = kind;
    row.dataset.video = target.videoId;
    row.setAttribute('role', 'menuitem');
    row.tabIndex = 0;
    row.append(svgIcon(kind === 'report' ? 'maybe' : 'human'), el('span', '', menuLabels(target.videoId)[kind]));
    const run = async (e) => {
      e.stopPropagation();
      closeMenu();
      const getChannel = () => target.channelId;
      if (kind === 'report') await onReportClick(target.videoId, getChannel);
      else await onHumanClick(target.videoId, getChannel, { disabled: false });
    };
    row.onclick = run;
    row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(e); } };
    return row;
  }

  function injectMenuItems() {
    if (!menuTarget || Date.now() - menuTarget.ts > 6000) return;
    for (const dd of document.querySelectorAll('tp-yt-iron-dropdown, ytd-popup-container yt-sheet-view-model')) {
      const r = dd.getBoundingClientRect();
      if (r.width < 50 || dd.querySelector('.byebot-menu-item')) continue; // closed, or already done
      const list = dd.querySelector(MENU_LISTS);
      if (!list) continue;
      // At the top: YouTube sizes the menu when it opens, so rows added at the end could end up
      // below the fold in its scroll area.
      const group = el('div', 'byebot-menu-group');
      group.append(makeMenuItem('report', menuTarget), makeMenuItem('human', menuTarget), el('div', 'byebot-menu-sep'));
      list.prepend(group);
      // Classic Polymer popups size themselves when opened; tell them the content changed.
      const resize = () => {
        for (const t of [list, list.closest('ytd-menu-popup-renderer'), dd]) t?.dispatchEvent(new CustomEvent('iron-resize', { bubbles: true, composed: true }));
      };
      resize();
      setTimeout(resize, 150);
      loadMyVote(menuTarget.videoId).then(refreshMenuItems);
    }
  }

  // ---- init -------------------------------------------------------------
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !alive()) return;
    if (changes.shortsMode) {
      shortsMode = changes.shortsMode.newValue ?? 'mark';
      skippedFor = null;
      document.querySelectorAll('[data-byebot-id]').forEach(clearCard);
      updateShortButtons();
      scheduleScan(true);
    }
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

  api.storage.local.get(['mode', 'shortsMode', CACHE_KEY]).then(({ mode: m, shortsMode: sm, [CACHE_KEY]: saved }) => {
    mode = m ?? 'hide';
    shortsMode = sm ?? 'mark';
    for (const [k, [label, ts, stats]] of Object.entries(saved?.ch ?? {})) chCache.set(k, { label, ts, stats });
    for (const [k, [label, ts]] of Object.entries(saved?.vid ?? {})) vidCache.set(k, { label, ts });
    observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.body, { childList: true, subtree: true });
    navHandler = () => scheduleScan(true);
    document.addEventListener('yt-navigate-finish', navHandler);
    scheduleScan(true);
  }).catch(() => shutdown());
})();
