'use strict';
const api = globalThis.browser || globalThis.chrome;
const $ = id => document.getElementById(id);

(async () => {
  const cfg = await api.storage.sync.get({ ...HL_DEFAULTS });
  $('enabled').checked = cfg.enabled;
  $('enabled').onchange = () => api.storage.sync.set({ enabled: $('enabled').checked });

  let host = '';
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const u = new URL(tab.url);
    if (/^https?:$/.test(u.protocol)) host = u.hostname.replace(/^www\./, '');
  } catch {}

  if (!host) { $('siteRow').style.display = 'none'; return; }
  $('host').textContent = host;
  const list = (cfg.blacklist || []).slice();
  const covered = () => list.some(p => host === p || host.endsWith('.' + p) || p.endsWith('.' + host));
  $('site').checked = !covered();
  $('site').onchange = async () => {
    for (let i = list.length - 1; i >= 0; i--) if (host === list[i] || host.endsWith('.' + list[i]) || list[i].endsWith('.' + host)) list.splice(i, 1);
    if (!$('site').checked) list.push(host);
    await api.storage.sync.set({ blacklist: list });
    $('note').textContent = 'Takes effect right away on open tabs.';
  };
})();

$('settings').onclick = () => { api.runtime.openOptionsPage(); window.close(); };
