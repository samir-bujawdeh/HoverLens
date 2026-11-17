'use strict';
const api = globalThis.browser || globalThis.chrome;
const fields = [...document.querySelectorAll('[data-k]')];
let statusTimer, saveTimer;

function read(el) {
  const k = el.dataset.k;
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number') { const n = parseFloat(el.value); return Number.isFinite(n) ? n : HL_DEFAULTS[k]; }
  if (k === 'blacklist') return el.value.split('\n').map(s => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')).filter(Boolean);
  return el.value;
}
function write(el, v) {
  if (el.type === 'checkbox') el.checked = !!v;
  else if (Array.isArray(v)) el.value = v.join('\n');
  else el.value = v;
}
function checkRules() {
  const el = document.querySelector('[data-k="userRules"]');
  document.getElementById('ruleErrors').textContent = HoverLensRules.compileUserRules(el.value).errors.join('\n');
}
function flash() {
  const s = document.getElementById('status');
  s.classList.add('on');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => s.classList.remove('on'), 1000);
}
async function load() {
  const cfg = await api.storage.sync.get({ ...HL_DEFAULTS });
  fields.forEach(el => write(el, cfg[el.dataset.k]));
  checkRules();
}
function save(el) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await api.storage.sync.set({ [el.dataset.k]: read(el) });
    flash();
  }, el.tagName === 'TEXTAREA' ? 500 : 0);
}

fields.forEach(el => el.addEventListener(el.tagName === 'TEXTAREA' || el.type === 'number' ? 'input' : 'change', () => {
  if (el.dataset.k === 'userRules') checkRules();
  save(el);
}));
document.getElementById('reset').onclick = async () => {
  if (!confirm('Restore all settings to their defaults? Your custom rules and site list will be cleared.')) return;
  await api.storage.sync.set({ ...HL_DEFAULTS });
  await load();
  flash();
};
load();
