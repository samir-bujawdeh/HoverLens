(() => {
  'use strict';
  if (window.__hoverLensLoaded) return;
  window.__hoverLensLoaded = true;

  const api = globalThis.browser || globalThis.chrome;
  const RULES = globalThis.HoverLensRules;
  const DEFAULTS = globalThis.HL_DEFAULTS;

  // ======================= settings =======================
  let cfg = { ...DEFAULTS };
  let userRules = [];
  let blocked = false;

  function hostMatches(pattern, host) {
    pattern = String(pattern).trim().toLowerCase().replace(/^\*\./, '');
    return !!pattern && (host === pattern || host.endsWith('.' + pattern));
  }
  function applySettings(s) {
    cfg = { ...DEFAULTS, ...s };
    userRules = RULES.compileUserRules(cfg.userRules).rules;
    blocked = !cfg.enabled || (cfg.blacklist || []).some(p => hostMatches(p, location.hostname));
    if (blocked) hide();
  }
  async function loadSettings() {
    try { applySettings(await api.storage.sync.get({ ...DEFAULTS })); } catch { applySettings({}); }
  }
  loadSettings();
  try { api.storage.onChanged.addListener((_, area) => { if (area === 'sync') loadSettings(); }); } catch {}

  function send(msg) {
    try { return Promise.resolve(api.runtime.sendMessage(msg)).catch(e => ({ error: String(e) })); }
    catch (e) { return Promise.resolve({ error: String(e) }); }
  }

  // ======================= state =======================
  let mx = 0, my = 0;           // last cursor position
  let hovered = null;           // target under the cursor
  let loadingFor = null;        // target currently being resolved/loaded
  let session = null;           // the visible popup
  let token = 0;                // bumps on every cancel, so stale async work is dropped
  let suppressedKey = null;     // Esc pressed: don't reopen until the cursor leaves this element
  let dragging = null;
  let wheelLock = false;
  const heldKeys = new Set();
  const BLOCK = Symbol('block');
  const fetchCache = new Map();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ======================= finding what's under the cursor =======================
  const FULL_ATTRS = ['data-full', 'data-full-src', 'data-fullsrc', 'data-zoom-image', 'data-zoom-src', 'data-large-file',
    'data-orig-file', 'data-original', 'data-hires', 'data-highres', 'data-hi-res', 'data-large', 'data-big'];
  const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-lazy', 'data-url'];

  function abs(u) { try { return new URL(u, document.baseURI).href; } catch { return null; } }
  const isMediaUrl = u => !!u && /^(https?:|blob:|data:image\/)/i.test(u);
  const isEditable = n => n instanceof Element && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName));

  function parseSrcset(s) {
    const out = []; let cur = null;
    for (const tok of s.trim().split(/\s+/)) {
      const comma = tok.endsWith(',');
      const t = comma ? tok.slice(0, -1) : tok;
      if (!cur) { cur = { url: t, score: 1 }; if (comma) { out.push(cur); cur = null; } continue; }
      const d = /^([\d.]+)([wxh])$/.exec(t);
      if (d) cur.score = parseFloat(d[1]) * (d[2] === 'x' ? 1000 : 1);
      if (d || comma) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out;
  }

  function imgSource(img) {
    for (const a of FULL_ATTRS) {
      const v = img.getAttribute(a);
      if (v && !/^\s*[{[]/.test(v)) { const u = abs(v.trim()); if (isMediaUrl(u)) return u; }
    }
    const sets = [img.getAttribute('srcset'), img.getAttribute('data-srcset')];
    if (img.parentElement && img.parentElement.tagName === 'PICTURE')
      for (const s of img.parentElement.querySelectorAll('source')) sets.push(s.getAttribute('srcset'), s.getAttribute('data-srcset'));
    let best = null, score = 0;
    for (const s of sets) if (s) for (const c of parseSrcset(s)) {
      if (c.score <= score) continue;
      const u = abs(c.url); if (isMediaUrl(u)) { best = u; score = c.score; }
    }
    let cur = img.currentSrc || img.src;
    if (!cur || cur.startsWith('data:')) for (const a of LAZY_ATTRS) { const v = img.getAttribute(a); if (v) { cur = abs(v) || cur; break; } }
    return best || (isMediaUrl(cur) ? cur : null);
  }

  function bgUrl(el) {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none') return null;
    const m = /url\((['"]?)(.*?)\1\)/.exec(bg);
    const u = m && abs(m[2]);
    return isMediaUrl(u) && !u.startsWith('data:') ? u : null;
  }

  function findTarget(node) {
    if (node && !(node instanceof Element)) node = node.parentElement;
    if (!node || node === hostEl || isEditable(node)) return null;
    if (/^(VIDEO|AUDIO|IFRAME|EMBED|OBJECT|CANVAS|HTML|BODY)$/.test(node.tagName)) return null;

    let link = node.closest('a[href]');
    let img = node.tagName === 'IMG' ? node : null;
    let bg = null;

    if (!img) {
      // Sites often lay a transparent element over the <img>; look through it.
      const stack = document.elementsFromPoint(mx, my);
      for (const el of stack.slice(0, 6)) {
        if (el === hostEl || el === document.body || el === document.documentElement) break;
        if (el.tagName === 'IMG') {
          if (node.contains(el) || !node.textContent.trim() || (link && link.contains(el))) img = el;
          break;
        }
      }
    }
    if (img) link = img.closest('a[href]') || link;
    if (!img) {
      const vw = innerWidth, vh = innerHeight;
      for (let el = node, i = 0; el && i < 2; el = el.parentElement, i++) {
        const r = el.getBoundingClientRect();
        if (r.width * r.height > vw * vh * 0.7) break;
        const u = bgUrl(el);
        if (u) { bg = { el, url: u }; break; }
      }
    }
    let href = link && typeof link.href === 'string' ? link.href : null;
    if (href && (/^(javascript|mailto|tel|data):/i.test(href) || href.split('#')[0] === location.href.split('#')[0])) href = null;
    if (!img && !bg && !href) return null;
    return { key: href ? link : (img || bg.el), node, img, bg, link: href ? link : null, href };
  }

  function captionFor(t) {
    const c = [t.img && t.img.alt, t.img && t.img.title, t.link && t.link.title, t.link && t.link.getAttribute('aria-label'),
      t.bg && t.bg.el.getAttribute('aria-label'), t.link && !t.img ? t.link.textContent : ''];
    for (let s of c) {
      s = (s || '').replace(/\s+/g, ' ').trim();
      if (s) return s.length > 300 ? s.slice(0, 297) + '…' : s;
    }
    return '';
  }

  // ======================= resolving URLs =======================
  function normItem(o) {
    if (typeof o === 'string') return { srcs: [{ u: o }] };
    if (Array.isArray(o)) return { srcs: o.map(u => typeof u === 'string' ? { u } : u) };
    const list = [].concat(o.src ?? o.srcs ?? []);
    return { srcs: list.map(u => typeof u === 'string' ? { u, type: o.type } : u), caption: o.caption, minWidth: o.minWidth };
  }
  function normalize(r) {
    if (r && r.items) { const a = r.items.map(normItem).filter(i => i.srcs.length); return a.length ? a : null; }
    const it = normItem(r);
    return it.srcs.length ? [it] : null;
  }

  async function resolveUrl(url, depth) {
    for (const rule of userRules.concat(RULES.builtin)) {
      const m = rule.match.exec(url);
      if (!m) continue;
      let r;
      try { r = rule.to(m, url); } catch { continue; }
      if (r === undefined) continue;
      if (r === null) return BLOCK;
      if (r.fetch) {
        if (depth > 0) return null;
        const items = await fetchItems(r.fetch, r.parse);
        if (!items || !items.length) return null;
        // Run extracted URLs through the rules too (e.g. a wiki thumbnail -> the original file).
        for (const it of items) {
          const first = it.srcs[0];
          if (!first || first.type === 'video') continue;
          const up = await resolveUrl(first.u, depth + 1);
          if (up && up !== BLOCK && up.length === 1) it.srcs = up[0].srcs.concat(it.srcs);
        }
        return items;
      }
      return normalize(r);
    }
    return null;
  }

  async function resolveTarget(t) {
    let items = null;
    if (t.href) {
      items = await resolveUrl(t.href, 0);
      if (items === BLOCK) return null;
    }
    const shown = t.img ? imgSource(t.img) : t.bg ? t.bg.url : null;
    if (shown) {
      let fromShown = await resolveUrl(shown, 0);
      if (fromShown === BLOCK) { if (!items) return null; fromShown = null; }
      const shownItems = fromShown || [{ srcs: [] }];
      if (shownItems.length === 1) shownItems[0].srcs.push({ u: shown }); // the displayed image is always the last resort
      if (!items) items = shownItems;
      else if (items.length === 1) items[0].srcs.push(...shownItems[0].srcs);
    }
    if (!items) return null;
    const caption = captionFor(t);
    for (const it of items) {
      const seen = new Set();
      it.srcs = it.srcs.filter(s => s && s.u && !seen.has(s.u) && seen.add(s.u));
      if (!it.caption) it.caption = caption;
    }
    return items.filter(it => it.srcs.length);
  }

  const PARSERS = {
    meta(text, base) {
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const absU = u => { try { return new URL(u, base).href; } catch { return null; } };
      const get = sel => [...doc.querySelectorAll(sel)]
        .map(e => e.getAttribute('content') || e.getAttribute('href')).filter(Boolean).map(absU).filter(Boolean);
      const title = ((doc.querySelector('meta[property="og:title"]') || {}).content || doc.title || '').trim();
      const videos = get('meta[property="og:video:secure_url"],meta[property="og:video:url"],meta[property="og:video"],meta[name="twitter:player:stream"]')
        .filter(u => RULES.VID_EXT.test(u));
      const full = doc.querySelector('.fullImageLink a[href], .fullMedia a[href]');
      const images = [...new Set([
        ...(full ? [absU(full.getAttribute('href'))] : []),
        ...get('meta[property="og:image:secure_url"],meta[property="og:image"],meta[property="og:image:url"],meta[name="twitter:image"],meta[name="twitter:image:src"],link[rel="image_src"]')
      ].filter(Boolean))];
      if (videos.length) return [{ srcs: [{ u: videos[0], type: 'video' }, ...images.slice(0, 1).map(u => ({ u }))], caption: title }];
      const ogs = [...new Set(get('meta[property="og:image"]'))];
      if (ogs.length > 1) return ogs.map(u => ({ srcs: [{ u }], caption: title }));
      return images.length ? [{ srcs: images.map(u => ({ u })), caption: title }] : null;
    },
    reddit(text) {
      const j = JSON.parse(text);
      const p = j[0].data.children[0].data;
      const d = (p.crosspost_parent_list && p.crosspost_parent_list[0]) || p;
      const title = d.title || '';
      if (d.is_gallery && d.media_metadata && d.gallery_data) {
        return d.gallery_data.items.map(g => {
          const m = d.media_metadata[g.media_id];
          if (!m || m.status !== 'valid' || !m.s) return null;
          const u = m.s.mp4 || m.s.u || m.s.gif;
          return u ? { srcs: [{ u, type: m.s.mp4 ? 'video' : undefined }], caption: g.caption || title } : null;
        }).filter(Boolean);
      }
      const rv = (d.secure_media && d.secure_media.reddit_video) || (d.media && d.media.reddit_video) || (d.preview && d.preview.reddit_video_preview);
      if (rv && rv.fallback_url) return [{ srcs: [{ u: rv.fallback_url, type: 'video' }], caption: title }];
      const srcs = [];
      if (d.url && (RULES.IMG_EXT.test(d.url) || /\/\/(i\.redd\.it|i\.imgur\.com|imgur\.com)\//.test(d.url))) srcs.push({ u: d.url });
      const pv = d.preview && d.preview.images && d.preview.images[0] && d.preview.images[0].source;
      if (pv && pv.url) srcs.push({ u: pv.url });
      return srcs.length ? [{ srcs, caption: title }] : null;
    }
  };

  async function fetchItems(url, parser) {
    const key = parser + ' ' + url;
    if (!fetchCache.has(key)) fetchCache.set(key, (async () => {
      const res = await send({ type: 'fetchText', url });
      if (!res || res.error || !res.text || !PARSERS[parser]) return null;
      try { return PARSERS[parser](res.text, res.url || url); } catch { return null; }
    })());
    const items = await fetchCache.get(key);
    return items && items.map(it => ({ srcs: it.srcs.slice(), caption: it.caption, minWidth: it.minWidth }));
  }

  // ======================= loading media =======================
  function loadImage(src) {
    return new Promise(res => {
      const im = new Image();
      const done = ok => { clearTimeout(to); im.onload = im.onerror = null; res(ok ? { el: im, w: im.naturalWidth, h: im.naturalHeight } : null); };
      const to = setTimeout(() => done(false), 20000);
      im.onload = () => done(true);
      im.onerror = () => done(false);
      im.decoding = 'async';
      im.src = src;
    });
  }
  function loadVideo(src) {
    return new Promise(res => {
      const v = document.createElement('video');
      const done = ok => { clearTimeout(to); v.onloadedmetadata = v.onerror = null; res(ok ? { el: v, w: v.videoWidth, h: v.videoHeight } : null); };
      const to = setTimeout(() => done(false), 20000);
      v.onloadedmetadata = () => done(true);
      v.onerror = () => done(false);
      v.muted = cfg.videoMuted; v.loop = true; v.playsInline = true; v.preload = 'auto';
      v.src = src;
    });
  }
  function loadItem(item) {
    if (!item.promise) item.promise = (async () => {
      for (const s of item.srcs) {
        const type = s.type || (RULES.VID_EXT.test(s.u) ? 'video' : 'image');
        const r = type === 'video' ? await loadVideo(s.u) : await loadImage(s.u);
        if (r && (!item.minWidth || r.w >= item.minWidth)) return { ...r, src: s.u, type };
      }
      return null;
    })();
    return item.promise;
  }

  function notBigger(t, L) {
    const el = t.img || (t.bg && t.bg.el);
    if (!el || !L.w) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    return L.w <= r.width * cfg.minScaleUp && L.h <= r.height * cfg.minScaleUp;
  }

  // ======================= opening / closing =======================
  function schedule(t) {
    if (cfg.trigger !== 'none' && !heldKeys.has(cfg.trigger)) return; // wait for the trigger key
    open(t, cfg.trigger === 'none' ? cfg.delay : 0);
  }

  async function open(t, delay) {
    const tk = ++token;
    loadingFor = t;
    const showAt = performance.now() + delay;
    let erred = false;
    const spinTimer = setTimeout(() => { if (tk === token) showSpinner(true); }, delay + 150);
    try {
      const items = await resolveTarget(t);
      if (tk !== token || !items || !items.length) return;
      const L = await loadItem(items[0]);
      if (tk !== token) return;
      if (!L) { erred = true; flashError(); return; }
      if (items.length === 1 && L.type === 'image' && notBigger(t, L)) return;
      const wait = showAt - performance.now();
      if (wait > 0) await sleep(wait);
      if (tk !== token) return;
      session = { t, items, index: 0, bar: cfg.showBar, locked: false, anchor: { x: mx, y: my } };
      mountMedia(session, L, items[0]);
      popEl.classList.add('on');
      layout();
      preload(session, 1);
    } finally {
      clearTimeout(spinTimer);
      if (tk === token) { loadingFor = null; if (!erred) showSpinner(false); }
    }
  }

  function hide() {
    token++;
    loadingFor = null;
    dragging = null;
    if (session && session.media && session.media.tagName === 'VIDEO') session.media.pause();
    session = null;
    if (popEl) {
      popEl.classList.remove('on', 'locked');
      backEl.style.display = 'none';
      stageEl.replaceChildren();
    }
    showSpinner(false);
  }

  async function go(i) {
    const s = session;
    if (!s || s.items.length < 2) return;
    const n = s.items.length;
    i = ((i % n) + n) % n;
    s.index = i;
    const tk = token;
    showSpinner(true);
    const L = await loadItem(s.items[i]);
    if (tk !== token || session !== s || s.index !== i) return;
    showSpinner(false);
    if (!L) { toast(`Couldn't load ${i + 1} of ${n}`); updateInfo(); return; }
    mountMedia(s, L, s.items[i]);
    layout();
    preload(s, i + 1);
  }
  function preload(s, i) {
    const n = s.items.length;
    if (n > 1) loadItem(s.items[((i % n) + n) % n]);
  }

  // ======================= UI =======================
  let hostEl, popEl, stageEl, barEl, capEl, infoEl, spinEl, backEl, toastEl, toastTimer;
  const CSS = `
    :host{all:initial}
    .back{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;pointer-events:none}
    .pop{position:fixed;display:none;pointer-events:none;background:#161616;border-radius:4px;overflow:hidden;
      box-shadow:0 8px 32px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.1)}
    .pop.on{display:block}
    .pop.locked{pointer-events:auto;cursor:grab;box-shadow:0 8px 32px rgba(0,0,0,.45),0 0 0 2px #3d8bfd}
    .pop.locked.drag{cursor:grabbing}
    .stage{position:absolute;inset:0;overflow:hidden}
    .stage>img,.stage>video{position:absolute;display:block;max-width:none;max-height:none;min-width:0;min-height:0;
      margin:0;padding:0;border:0;transform-origin:50% 50%;user-select:none;-webkit-user-drag:none}
    .bar{position:absolute;left:0;right:0;bottom:0;display:flex;gap:12px;justify-content:space-between;align-items:flex-end;
      padding:22px 10px 7px;background:linear-gradient(rgba(0,0,0,0),rgba(0,0,0,.75));color:#fff;
      font:12px/1.35 -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;text-shadow:0 1px 2px rgba(0,0,0,.8);pointer-events:none}
    .bar.off{display:none}
    .cap{overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;min-width:0}
    .info{white-space:nowrap;opacity:.85;font-variant-numeric:tabular-nums;margin-left:auto}
    .spin{position:fixed;width:20px;height:20px;box-sizing:border-box;border-radius:50%;border:3px solid rgba(255,255,255,.4);
      border-top-color:#3d8bfd;box-shadow:0 0 0 1px rgba(0,0,0,.25);display:none;pointer-events:none;animation:r .7s linear infinite}
    .spin.on{display:block}
    .spin.err{animation:none;border-color:#e5484d;background:#e5484d}
    @keyframes r{to{transform:rotate(360deg)}}
    .toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:rgba(24,24,24,.92);color:#fff;
      font:13px -apple-system,BlinkMacSystemFont,sans-serif;padding:7px 12px;border-radius:6px;display:none;pointer-events:none}
    .toast.on{display:block}`;

  function ensureUI() {
    if (hostEl) { if (!hostEl.isConnected) document.documentElement.appendChild(hostEl); return; }
    hostEl = document.createElement('hoverlens-ui');
    hostEl.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const root = hostEl.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style><div class="back"></div><div class="pop"><div class="stage"></div>` +
      `<div class="bar"><span class="cap"></span><span class="info"></span></div></div><div class="spin"></div><div class="toast"></div>`;
    const q = s => root.querySelector(s);
    backEl = q('.back'); popEl = q('.pop'); stageEl = q('.stage'); barEl = q('.bar');
    capEl = q('.cap'); infoEl = q('.info'); spinEl = q('.spin'); toastEl = q('.toast');
    popEl.addEventListener('mousedown', e => {
      if (!session || !session.locked || e.button !== 0) return;
      if (e.target.tagName === 'VIDEO' && e.offsetY > e.target.clientHeight - 48) return; // video controls
      e.preventDefault();
      dragging = { x: e.clientX, y: e.clientY, cx: session.cx, cy: session.cy };
      popEl.classList.add('drag');
    });
    popEl.addEventListener('dblclick', () => { if (session && session.locked) toggleActual(session); });
    document.documentElement.appendChild(hostEl);
  }

  function mountMedia(s, L, item) {
    ensureUI();
    if (s.media && s.media !== L.el && s.media.tagName === 'VIDEO') s.media.pause();
    stageEl.replaceChildren(L.el);
    Object.assign(s, { media: L.el, w: L.w || 0, h: L.h || 0, src: L.src, type: L.type,
      rot: 0, fh: false, fv: false, zoomScale: null, actual: false });
    capEl.textContent = item.caption || '';
    if (L.type === 'video') {
      L.el.controls = cfg.videoControls || s.locked;
      L.el.muted = cfg.videoMuted;
      const p = L.el.play();
      if (p) p.catch(() => { L.el.muted = true; L.el.play().catch(() => {}); });
    }
  }

  function layout() {
    const s = session;
    if (!s || !popEl) return;
    const vw = Math.min(innerWidth, document.documentElement.clientWidth || innerWidth), vh = innerHeight;
    const M = 6, G = 16;
    const w = s.w || Math.min(1024, vw), h = s.h || Math.min(768, vh);
    const sw = s.rot % 180 ? h : w, sh = s.rot % 180 ? w : h;
    const fit = (aw, ah) => Math.max(0, Math.min(1, aw / sw, ah / sh));
    const full = fit(vw - 2 * M, vh - 2 * M);
    let scale = full, mode = 'center';
    if (s.actual) scale = 1;
    else if (s.zoomScale) scale = s.zoomScale;
    else if (!s.locked && cfg.displayMode !== 'center') {
      const a = s.anchor;
      const opts = [
        ['right', fit(vw - a.x - G - M, vh - 2 * M)],
        ['left', fit(a.x - G - M, vh - 2 * M)],
        ['below', fit(vw - 2 * M, vh - a.y - G - M)],
        ['above', fit(vw - 2 * M, a.y - G - M)]
      ].sort((p, q) => q[1] - p[1]);
      if (cfg.displayMode === 'side' || opts[0][1] >= full * 0.7) { mode = opts[0][0]; scale = opts[0][1]; }
    }
    const bw = sw * scale, bh = sh * scale, a = s.anchor;
    let left, top;
    if (s.locked) { left = s.cx - bw / 2; top = s.cy - bh / 2; }
    else if (mode === 'right') { left = a.x + G; top = clamp(a.y - bh / 2, M, vh - M - bh); }
    else if (mode === 'left') { left = a.x - G - bw; top = clamp(a.y - bh / 2, M, vh - M - bh); }
    else if (mode === 'below') { top = a.y + G; left = clamp(a.x - bw / 2, M, vw - M - bw); }
    else if (mode === 'above') { top = a.y - G - bh; left = clamp(a.x - bw / 2, M, vw - M - bw); }
    else {
      // centered; when bigger than the window, pan with the mouse
      left = bw <= vw - 2 * M ? (vw - bw) / 2 : M - (bw - (vw - 2 * M)) * clamp(mx / vw, 0, 1);
      top = bh <= vh - 2 * M ? (vh - bh) / 2 : M - (bh - (vh - 2 * M)) * clamp(my / vh, 0, 1);
    }
    Object.assign(s, { mode, scale, box: { left, top, bw, bh } });
    Object.assign(popEl.style, { left: left + 'px', top: top + 'px', width: bw + 'px', height: bh + 'px' });
    const mw = w * scale, mh = h * scale;
    Object.assign(s.media.style, {
      width: mw + 'px', height: mh + 'px', left: (bw - mw) / 2 + 'px', top: (bh - mh) / 2 + 'px',
      transform: `rotate(${s.rot}deg) scale(${s.fh ? -1 : 1},${s.fv ? -1 : 1})`
    });
    backEl.style.display = cfg.backdrop && mode === 'center' && !s.locked ? 'block' : 'none';
    updateInfo();
  }

  function updateInfo() {
    const s = session;
    if (!s) return;
    const parts = [];
    if (s.items.length > 1) parts.push(`${s.index + 1} / ${s.items.length}`);
    if (s.w) parts.push(`${s.w}×${s.h}`);
    if (s.scale) parts.push(`${Math.round(s.scale * 100)}%`);
    if (s.rot) parts.push(`${s.rot}°`);
    infoEl.textContent = parts.join(' · ');
    barEl.classList.toggle('off', !s.bar);
  }

  function showSpinner(on, err) {
    if (!on && !spinEl) return;
    ensureUI();
    spinEl.classList.toggle('on', !!on);
    spinEl.classList.toggle('err', !!err);
    if (on) { spinEl.style.left = mx + 14 + 'px'; spinEl.style.top = my + 14 + 'px'; }
  }
  function flashError() {
    showSpinner(true, true);
    const tk = token;
    setTimeout(() => { if (tk === token && !session) showSpinner(false); }, 700);
  }
  function toast(msg) {
    ensureUI();
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1600);
  }

  // ======================= actions =======================
  function zoomBy(s, f) {
    s.zoomScale = clamp(s.scale * f, 0.05, 30);
    s.actual = false;
    layout();
  }
  function toggleActual(s) {
    s.actual = !s.actual;
    s.zoomScale = null;
    layout();
  }
  function toggleLock(s) {
    if (s.locked) { hide(); return; }
    s.locked = true;
    s.cx = s.box.left + s.box.bw / 2;
    s.cy = s.box.top + s.box.bh / 2;
    if (!s.actual && !s.zoomScale) s.zoomScale = s.scale;
    popEl.classList.add('locked');
    if (s.type === 'video') s.media.controls = true;
    layout();
    toast('Pinned — drag to move, L or Esc to close');
  }
  function openTab(url, active) {
    send({ type: 'openTab', url, active }).then(r => { if (!r || r.error) window.open(url, '_blank', 'noopener'); });
  }
  function fileName(url, mime, type) {
    let name = 'image';
    try { name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || name); } catch {}
    name = name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
    if (!/\.\w{2,5}$/.test(name)) {
      const ext = (mime && mime.split('/')[1]) || (type === 'video' ? 'mp4' : 'jpg');
      name += '.' + ext.replace('jpeg', 'jpg').replace(/\+.*/, '');
    }
    return name;
  }
  async function save(s) {
    const url = s.src;
    toast('Saving…');
    const res = await send({ type: 'fetchDataURL', url });
    const a = document.createElement('a');
    a.href = res && res.dataURL ? res.dataURL : url;
    a.download = fileName(url, res && res.mime, s.type);
    a.rel = 'noopener';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    toast(res && res.dataURL ? `Saved ${a.download}` : 'Opened the file to save it');
  }
  function copyUrl(s) {
    Promise.resolve().then(() => navigator.clipboard.writeText(s.src))
      .then(() => toast('Link copied'), () => toast("Couldn't copy the link"));
  }

  const navNext = s => s.items.length > 1 ? (go(s.index + 1), true) : false;
  const navPrev = s => s.items.length > 1 ? (go(s.index - 1), true) : false;
  const ACTIONS = {
    Escape: s => { suppressedKey = s.t.key; hide(); },
    Enter: (s, e) => openTab(s.src, !e.shiftKey),
    o: (s, e) => openTab(s.src, !e.shiftKey),
    ArrowRight: navNext, ArrowDown: navNext, PageDown: navNext, j: navNext,
    ArrowLeft: navPrev, ArrowUp: navPrev, PageUp: navPrev, k: navPrev,
    Home: s => s.items.length > 1 ? (go(0), true) : false,
    End: s => s.items.length > 1 ? (go(s.items.length - 1), true) : false,
    ' ': s => {
      if (s.type === 'video') { s.media.paused ? s.media.play().catch(() => {}) : s.media.pause(); return true; }
      return navNext(s);
    },
    '+': s => zoomBy(s, 1.25), '=': s => zoomBy(s, 1.25),
    '-': s => zoomBy(s, 0.8), '_': s => zoomBy(s, 0.8),
    '0': s => { Object.assign(s, { zoomScale: null, actual: false, rot: 0, fh: false, fv: false }); layout(); },
    z: toggleActual,
    r: (s, e) => { s.rot = (s.rot + (e.shiftKey ? 270 : 90)) % 360; layout(); },
    h: s => { if (s.rot % 180) s.fv = !s.fv; else s.fh = !s.fh; layout(); },
    v: s => { if (s.rot % 180) s.fh = !s.fh; else s.fv = !s.fv; layout(); },
    c: s => { s.bar = !s.bar; updateInfo(); },
    s: save,
    u: copyUrl,
    l: toggleLock,
    m: s => { if (s.type !== 'video') return false; s.media.muted = !s.media.muted; toast(s.media.muted ? 'Muted' : 'Sound on'); }
  };

  // ======================= events =======================
  const MODS = { Shift: 'shift', Control: 'ctrl', Alt: 'alt', Meta: 'meta' };

  function onOver(e) {
    if (blocked || (session && session.locked)) return;
    mx = e.clientX; my = e.clientY;
    const node = e.composedPath ? e.composedPath()[0] : e.target;
    if (hostEl && node === hostEl) return;
    const t = findTarget(node);
    if (t && hovered && t.key === hovered.key) return;
    hovered = t;
    if (suppressedKey && (!t || t.key !== suppressedKey)) suppressedKey = null;
    if (session || loadingFor) hide();
    if (t && t.key !== suppressedKey) schedule(t);
  }

  function onMove(e) {
    mx = e.clientX; my = e.clientY;
    const s = session;
    if (dragging && s) {
      s.cx = dragging.cx + (mx - dragging.x);
      s.cy = dragging.cy + (my - dragging.y);
      layout();
      return;
    }
    if (spinEl && spinEl.classList.contains('on')) { spinEl.style.left = mx + 14 + 'px'; spinEl.style.top = my + 14 + 'px'; }
    if (s && !s.locked) {
      if (!s.t.key.isConnected) { hovered = null; hide(); return; }
      if (s.mode === 'center' && (s.box.bw > innerWidth || s.box.bh > innerHeight)) layout();
    }
  }

  function onKeyDown(e) {
    const mod = MODS[e.key];
    if (mod) {
      heldKeys.add(mod);
      if (mod === cfg.trigger && !blocked && hovered && !session && !loadingFor && hovered.key !== suppressedKey) open(hovered, 0);
      return;
    }
    if (e.key === 'Escape' && loadingFor && !session) { suppressedKey = loadingFor.key; hide(); return; }
    const s = session;
    if (!s || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isEditable(e.composedPath ? e.composedPath()[0] : e.target)) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const act = ACTIONS[k];
    if (!act || act(s, e) === false) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onKeyUp(e) {
    const mod = MODS[e.key];
    if (mod) heldKeys.delete(mod);
  }

  function onWheel(e) {
    const s = session;
    if (!s || cfg.wheel === 'off' || e.ctrlKey || e.metaKey) return;
    if (s.locked && !e.composedPath().includes(hostEl)) return;
    const d = e.deltaY || e.deltaX;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    let nav = cfg.wheel === 'album';
    if (e.shiftKey) nav = !nav;
    if (nav && s.items.length > 1) {
      if (wheelLock) return;
      wheelLock = true;
      setTimeout(() => { wheelLock = false; }, 220);
      go(s.index + (d > 0 ? 1 : -1));
    } else {
      const px = e.deltaMode === 1 ? d * 33 : d;
      zoomBy(s, Math.exp(-px * 0.002));
    }
  }

  function onScroll(e) {
    if (!session && !loadingFor) return;
    if (session && session.locked) return;
    const tgt = e.target;
    const key = (session || {}).t ? session.t.key : loadingFor && loadingFor.key;
    if (tgt === document || tgt === document.documentElement || (tgt.contains && key && tgt.contains(key))) { hovered = null; hide(); }
  }

  window.addEventListener('mouseover', onOver, true);
  window.addEventListener('mousemove', onMove, { capture: true, passive: true });
  window.addEventListener('mouseup', () => { if (dragging) { dragging = null; popEl.classList.remove('drag'); } }, true);
  window.addEventListener('mousedown', e => {
    if (session && session.locked && !e.composedPath().includes(hostEl)) hide();
    else if (session && !session.locked && e.button === 0) { suppressedKey = session.t.key; hide(); }
  }, true);
  window.addEventListener('mouseout', e => {
    if (!e.relatedTarget && !(session && session.locked)) { hovered = null; if (session || loadingFor) hide(); }
  }, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', () => heldKeys.clear());
  window.addEventListener('wheel', onWheel, { capture: true, passive: false });
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('resize', () => layout());
  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); });
})();
