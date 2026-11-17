'use strict';
// Does the work content scripts can't do themselves: cross-origin fetches and opening tabs.
const api = globalThis.browser || globalThis.chrome;
const MAX_TEXT = 3 * 1024 * 1024;
const MAX_BLOB = 150 * 1024 * 1024;

async function timedFetch(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { signal: ctl.signal, credentials: 'include', redirect: 'follow' }); }
  finally { clearTimeout(t); }
}

async function handle(msg, sender) {
  if (!msg || typeof msg !== 'object') return { error: 'bad message' };
  switch (msg.type) {
    case 'fetchText': {
      if (!/^https?:/i.test(msg.url)) return { error: 'bad url' };
      const r = await timedFetch(msg.url, 15000);
      if (!r.ok) return { error: 'HTTP ' + r.status };
      const text = await r.text();
      return { text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text, url: r.url };
    }
    case 'fetchDataURL': {
      if (!/^(https?|blob):/i.test(msg.url)) return { error: 'bad url' };
      const r = await timedFetch(msg.url, 60000);
      if (!r.ok) return { error: 'HTTP ' + r.status };
      const blob = await r.blob();
      if (blob.size > MAX_BLOB) return { error: 'too large' };
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      const mime = blob.type || 'application/octet-stream';
      return { dataURL: `data:${mime};base64,${btoa(bin)}`, mime };
    }
    case 'openTab': {
      if (!/^https?:/i.test(msg.url)) return { error: 'bad url' };
      const opts = { url: msg.url, active: msg.active !== false };
      if (sender && sender.tab) {
        opts.index = sender.tab.index + 1;
        if (sender.tab.windowId !== undefined) opts.windowId = sender.tab.windowId;
      }
      await api.tabs.create(opts);
      return { ok: true };
    }
  }
  return { error: 'unknown message' };
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, e => sendResponse({ error: String((e && e.message) || e) }));
  return true;
});
