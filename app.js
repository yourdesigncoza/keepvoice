/* KeepVoice — single-user list app. No backend; state lives in localStorage.
   Three inputs (type, speak, photo). One model turns speech and photos into list actions. */
(() => {
'use strict';

const STORE_KEY = 'keepvoice.v1';
const UNDO_DEPTH = 15;
const MODEL = 'google/gemini-3.1-flash-lite';
const PHOTO_MAX_PX = 1024;
const ARTICLES = /^(?:a|an|some|the|my|more)\s+/i;
const SPLIT = /\s*(?:,|\band\b|\bplus\b|\balso\b|&)\s*/i;
const LEADING_VERB = /^(?:please )?(?:add|put|get|buy|i need|we need|i want|need|pick up)\s+/i;

// ---------- state ----------
let state = load();
let undoStack = [];
let currentListId = null;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.lists)) {
      s.settings = { key: '', ...(s.settings || {}) };
      return s;
    }
  } catch (e) { /* fall through */ }
  return { lists: [], settings: { key: '' }, lastList: null };
}

function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

function snapshot() {
  undoStack.push(JSON.stringify({ lists: state.lists, lastList: state.lastList }));
  if (undoStack.length > UNDO_DEPTH) undoStack.shift();
}

function undo() {
  const prev = undoStack.pop();
  if (!prev) return false;
  Object.assign(state, JSON.parse(prev));
  save();
  if (currentListId && !listById(currentListId)) go('');
  return true;
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const key = (s) => s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const listById = (id) => state.lists.find((l) => l.id === id);
const currentList = () => listById(currentListId) || listById(state.lastList) || state.lists[0] || null;
const split = (text) => text.split(SPLIT).map((s) => s.trim()).filter(Boolean);

// ---------- fuzzy matching ----------
function score(query, candidate) {
  const q = key(query), c = key(candidate);
  if (!q || !c) return 0;
  if (q === c) return 3;
  if (c.includes(q) || q.includes(c)) return 2;
  const qw = new Set(q.split(' ')), cw = c.split(' ');
  const hits = cw.filter((w) => qw.has(w)).length;
  return hits ? 1 + hits / Math.max(qw.size, cw.length) : 0;
}

function best(query, candidates, nameOf) {
  let top = null, topScore = 0;
  for (const c of candidates) {
    const s = score(query, nameOf(c));
    if (s > topScore) { top = c; topScore = s; }
  }
  return top;
}

const findList = (name) => best(name, state.lists, (l) => l.name);
const findItem = (list, name, active) =>
  best(name, list.items.filter((i) => active === undefined || i.active === active), (i) => i.name);

// ---------- mutations (every change goes through these) ----------
function createList(name) {
  const list = { id: uid(), name: cap(name.trim()) || 'Untitled', items: [], created: Date.now() };
  state.lists.unshift(list);
  return list;
}

function addItems(list, names) {
  const added = [], dupes = [];
  for (const raw of names) {
    const name = cap(raw.replace(ARTICLES, '').trim());
    if (!name) continue;
    const existing = list.items.find((i) => key(i.name) === key(name));
    if (existing && existing.active) { dupes.push(name); continue; }
    if (existing) { existing.active = true; existing.created = Date.now(); }
    else list.items.push({ id: uid(), name, active: true, count: 0, lastDone: null, created: Date.now() });
    added.push(name);
  }
  return { added, dupes };
}

function tickItem(item) {
  item.active = false;
  item.count += 1;
  item.lastDone = Date.now();
}

function removeItem(list, item) {
  list.items = list.items.filter((i) => i !== item);
}

// ---------- action executor (model output, fallback and UI all end up here) ----------
function execute(actions) {
  const msgs = [];
  let snapped = false;
  for (const a of actions) {
    if (a.type === 'undo') { msgs.push(undo() ? 'Undone' : 'Nothing to undo'); continue; }
    if (!snapped) { snapshot(); snapped = true; }

    if (a.type === 'new_list') {
      const l = createList(a.name || 'Untitled');
      go('list/' + l.id);
      msgs.push(`Created ${l.name}`);
      continue;
    }
    if (a.type === 'open_list') {
      const l = findList(a.name || '');
      if (l) { go('list/' + l.id); msgs.push(`Opened ${l.name}`); }
      else msgs.push(`No list called ${a.name}`);
      continue;
    }

    let list = a.list ? findList(a.list) : currentList();
    if (!list && a.type === 'add') list = createList(a.list || 'Shopping list');
    if (!list) { msgs.push('Open a list first'); continue; }
    const items = Array.isArray(a.items) ? a.items : [];

    if (a.type === 'add') {
      const { added, dupes } = addItems(list, items);
      if (added.length) msgs.push(`Added ${added.join(', ')} to ${list.name}`);
      if (dupes.length) msgs.push(`${dupes.join(', ')} already on list`);
    } else if (a.type === 'tick' || a.type === 'remove' || a.type === 'untick') {
      const done = [], missing = [];
      for (const name of items) {
        const item = a.type === 'untick' ? findItem(list, name, false)
                   : findItem(list, name, a.type === 'tick' ? true : undefined);
        if (!item) { missing.push(name); continue; }
        if (a.type === 'tick') tickItem(item);
        else if (a.type === 'remove') removeItem(list, item);
        else { item.active = true; item.created = Date.now(); }
        done.push(item.name);
      }
      const verb = { tick: 'Ticked', remove: 'Removed', untick: 'Re-added' }[a.type];
      if (done.length) msgs.push(`${verb} ${done.join(', ')}`);
      if (missing.length) msgs.push(`Couldn't find ${missing.join(', ')}`);
    } else if (a.type === 'clear') {
      list.items.filter((i) => i.active).forEach(tickItem);
      msgs.push(`Cleared ${list.name}`);
    }
  }
  save();
  render();
  return msgs.join('. ');
}

// ---------- the model ----------
function listContext() {
  const cur = currentList();
  return {
    lists: state.lists.map((l) => l.name),
    current_list: cur ? cur.name : null,
    to_buy: cur ? cur.items.filter((i) => i.active).map((i) => i.name) : [],
    bought_before: cur ? cur.items.filter((i) => !i.active).map((i) => i.name) : [],
  };
}

const SA_NOTE = 'The user shops in South Africa. Speech-to-text and photos often involve local brands (Omo, Sunlight, Koo, Ouma, Simba, ' +
  'All Gold, Tastic, Iwisa, Cremora, Ricoffy, Oros, Clover, Albany, Lucky Star, biltong, boerewors, rusks, mielie meal and the like). ' +
  'Correct mangled brand names to the real brand (e.g. "oh mo" -> "Omo", "coo beans" -> "Koo beans"). Prefer names already in the user\'s lists.';

async function askModel(system, userContent) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.settings.key },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) throw new Error('model ' + res.status);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

async function interpret(text) {
  const system = `You convert a spoken shopping/todo command into JSON actions.
Return ONLY {"actions":[...]}. Action types:
{"type":"add","items":["milk","eggs"],"list":"Groceries"} (list optional = current)
{"type":"tick","items":[...]} {"type":"untick","items":[...]} {"type":"remove","items":[...]}
{"type":"new_list","name":"..."} {"type":"open_list","name":"..."} {"type":"clear"} {"type":"undo"}
Plain product names with no verb mean add. Items are short noun phrases, no articles; keep brand and pack size when said.
Match tick/remove names to existing items when close. ${SA_NOTE}
Context: ${JSON.stringify(listContext())}`;
  const out = await askModel(system, text);
  return Array.isArray(out.actions) ? out.actions : [];
}

async function identify(dataUrl) {
  const system = `Identify the grocery or household product in the photo for a shopping list.
Return ONLY {"label": "<brand> <product> <variant> <pack size>", "sure": true|false}.
Keep the label short, as a shopper would write it, e.g. "Simba salt & vinegar chips 125 g" or "Omo auto washing powder 2 kg".
Omit the size if it is not readable. If no product is visible, return {"label": "", "sure": false}. ${SA_NOTE}
Context: ${JSON.stringify(listContext())}`;
  return askModel(system, [
    { type: 'text', text: 'What product is this?' },
    { type: 'image_url', image_url: { url: dataUrl } },
  ]);
}

// Offline / no key / model error: treat the words as items to add. Nothing is lost.
function fallbackActions(text) {
  return [{ type: 'add', items: split(text.replace(LEADING_VERB, '')) }];
}

async function handleUtterance(text) {
  if (!text.trim()) return;
  let actions = null, note = '';
  if (state.settings.key) {
    try { actions = await interpret(text); }
    catch (e) { console.warn(e); note = ' (added as heard, model unavailable)'; }
  } else note = ' (added as heard, no API key)';
  if (!actions || !actions.length) { actions = fallbackActions(text); } else note = '';
  toast((execute(actions) || "Didn't understand") + note);
}

async function handlePhoto(file) {
  if (!state.settings.key) { toast('Add your OpenRouter key in Settings to use photos'); return; }
  showSheet('Looking', 'Identifying the product…');
  try {
    const dataUrl = await shrink(file);
    const { label, sure } = await identify(dataUrl);
    if (!label) { toast("Couldn't see a product in that photo"); return; }
    const msg = execute([{ type: 'add', items: [label] }]);
    toast(sure ? msg : `${msg} (best guess)`);
  } catch (e) {
    console.warn(e);
    toast('Photo failed: ' + e.message);
  } finally { hideSheet(); }
}

function shrink(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, PHOTO_MAX_PX / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => reject(new Error('could not read image'));
    img.src = URL.createObjectURL(file);
  });
}

// ---------- speech recognition ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;

function startListening() {
  if (!SR) { toast('Speech recognition is not supported in this browser'); return; }
  if (rec) { rec.stop(); return; }
  rec = new SR();
  rec.lang = 'en-ZA';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let finalText = '';
  showSheet('Listening', 'Say what you need', true);
  $('#mic-btn').classList.add('live');
  rec.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    showSheet('Listening', finalText || interim);
  };
  rec.onerror = (ev) => { if (ev.error !== 'aborted') toast('Mic error: ' + ev.error); };
  rec.onend = () => {
    rec = null;
    $('#mic-btn').classList.remove('live');
    hideSheet();
    if (finalText) handleUtterance(finalText);
  };
  try { rec.start(); } catch (e) { toast('Could not start the mic'); rec = null; hideSheet(); }
}

function cancelListening() {
  if (rec) { rec.onend = null; rec.abort(); rec = null; }
  $('#mic-btn').classList.remove('live');
  hideSheet();
}

// ---------- UI ----------
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'on') for (const [e, f] of Object.entries(v)) n.addEventListener(e, f);
    else if (k in n && k !== 'style') n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
};
const svg = (markup) => { const t = el('template'); t.innerHTML = markup; return t.content.firstElementChild; };
const ICON_TICK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

const fmtDate = (ts) => ts ? new Date(ts).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const activeOf = (list) => list.items.filter((i) => i.active).sort((a, b) => a.created - b.created);
const historyOf = (list) => list.items.filter((i) => !i.active).sort((a, b) => b.lastDone - a.lastDone);
const lastTouched = (list) => Math.max(list.created, ...list.items.map((i) => Math.max(i.created, i.lastDone || 0)));

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

function showSheet(status, text, placeholder = false) {
  $('#sheet-status').textContent = status;
  $('#sheet-text').textContent = text;
  $('#sheet-text').classList.toggle('placeholder', placeholder);
  $('#sheet-cancel').hidden = status !== 'Listening';
  $('#sheet').hidden = false;
}
function hideSheet() { $('#sheet').hidden = true; }

function go(hash) { location.hash = hash; route(); }

function route() {
  const m = location.hash.match(/^#list\/(.+)$/);
  currentListId = m && listById(m[1]) ? m[1] : null;
  if (currentListId) { state.lastList = currentListId; save(); }
  render();
}

function render() {
  const view = $('#view');
  view.replaceChildren();
  const list = currentListId && listById(currentListId);
  $('#back-btn').hidden = !list;
  $('#add-form').hidden = !list;
  if (list) renderList(view, list); else renderHome(view);
}

function previewOf(list, max) {
  const active = activeOf(list);
  const box = el('div', { className: 'preview' }, ...active.slice(0, max).map((i) => el('span', {}, i.name)));
  if (active.length > max) box.append(el('span', { className: 'more' }, `+${active.length - max} more`));
  if (!active.length) box.append(el('span', { className: 'more' }, 'nothing to buy'));
  return box;
}

function renderHome(view) {
  const toBuy = state.lists.reduce((n, l) => n + activeOf(l).length, 0);
  view.append(el('h1', { className: 'display' }, 'Lists'));
  view.append(el('p', { className: 'subline' }, plural(state.lists.length, 'list'), ' · ', el('b', {}, plural(toBuy, 'thing')), ' to buy'));

  const hero = currentList();
  if (hero) {
    const bought = historyOf(hero).length;
    const openHero = (anchor) => { go('list/' + hero.id); if (anchor) $('.history')?.scrollIntoView({ behavior: 'smooth' }); };
    view.append(el('div', { className: 'hero', role: 'button', tabIndex: 0, on: { click: () => openHero(false), keydown: (e) => { if (e.key === 'Enter') openHero(false); } } },
      el('p', { className: 'card-title' }, hero.name),
      previewOf(hero, 4),
      el('div', { className: 'meta' }, fmtDate(lastTouched(hero))),
      bought ? el('button', { className: 'bought', on: { click: (e) => { e.stopPropagation(); openHero(true); } } },
        el('span', {}, `${bought} bought before · tap to re-add`), el('span', {}, '›')) : null));
  }

  const cards = el('div', { className: 'cards' });
  for (const l of state.lists) {
    if (l === hero) continue;
    cards.append(el('button', { className: 'card', on: { click: () => go('list/' + l.id) } },
      el('p', { className: 'card-title' }, l.name),
      previewOf(l, 3),
      el('div', { className: 'meta' }, el('span', {}, fmtDate(lastTouched(l))))));
  }
  cards.append(el('button', { className: 'card new', on: { click: newListPrompt } }, '+ New list'));
  view.append(cards);
}

function renderList(view, list) {
  const active = activeOf(list);
  const history = historyOf(list);
  view.append(el('h1', { className: 'display' }, list.name));
  view.append(el('p', { className: 'subline' }, el('b', {}, plural(active.length, 'thing')), ' to buy · ', history.length, ' bought before'));

  const ul = el('ul', { className: 'items' });
  for (const item of active) {
    const li = el('li', { className: 'item' });
    const tick = () => {
      li.classList.add('ticking');
      setTimeout(() => { snapshot(); tickItem(item); save(); render(); toast(`Ticked ${item.name}`); }, 220);
    };
    li.append(
      el('button', { className: 'check', 'aria-label': `Tick ${item.name}`, on: { click: tick } }, svg(ICON_TICK)),
      el('span', { className: 'name' }, item.name),
      el('button', { className: 'del', 'aria-label': `Remove ${item.name}`, on: { click: () => { snapshot(); removeItem(list, item); save(); render(); } } }, svg(ICON_X)));
    ul.append(li);
  }
  view.append(ul);
  if (!active.length) {
    view.append(el('p', { className: 'empty' }, 'Nothing to buy. Speak, snap a photo, or type', history.length ? ', or tap something below.' : '.'));
  }
  if (history.length) {
    const chips = el('div', { className: 'chips' }, ...history.map((item) =>
      el('button', { className: 'chip', on: { click: () => { snapshot(); item.active = true; item.created = Date.now(); save(); render(); } } },
        item.name, el('small', {}, '×' + item.count))));
    view.append(el('section', { className: 'history' }, el('h3', {}, 'Bought before'), chips));
  }
  $('#history-list').replaceChildren(...history.map((i) => el('option', { value: i.name })));
}

function newListPrompt() {
  const name = prompt('List name');
  if (name) { snapshot(); const l = createList(name); save(); go('list/' + l.id); }
}

function exportJSON() {
  const blob = new Blob([JSON.stringify({ lists: state.lists }, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `keepvoice-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
}

// Merge lists by id, else by name, so a seed or backup never duplicates what is already there.
function mergeLists(lists) {
  for (const l of lists) {
    const idx = state.lists.findIndex((x) => x.id === l.id || key(x.name) === key(l.name));
    if (idx < 0) { state.lists.push(l); continue; }
    const target = state.lists[idx];
    for (const item of l.items) {
      const existing = target.items.find((i) => key(i.name) === key(item.name));
      if (!existing) target.items.push(item);
      else if (item.active) existing.active = true;
    }
  }
}

function importData(data, label) {
  if (!data || !Array.isArray(data.lists)) throw new Error('not a KeepVoice backup');
  snapshot();
  mergeLists(data.lists);
  save(); render();
  toast(`${label} ${plural(data.lists.length, 'list')}`);
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try { importData(JSON.parse(reader.result), 'Imported'); }
    catch (e) { toast('Import failed: ' + e.message); }
  };
  reader.readAsText(file);
}

async function loadSeed() {
  try {
    const res = await fetch('seed.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    for (const l of data.lists) {
      l.id = l.id || uid(); l.created = l.created || Date.now();
      l.items = l.items.map((i) => ({ id: uid(), count: 0, created: Date.now(), ...i, lastDone: i.active ? null : (i.lastDone || Date.now()) }));
    }
    importData(data, 'Loaded');
  } catch (e) { toast('Seed failed: ' + e.message); }
}

function menuAction(action) {
  const list = currentListId && listById(currentListId);
  if (['rename', 'clear-history', 'delete-list'].includes(action) && !list) { toast('Open a list first'); return; }
  switch (action) {
    case 'rename': { const n = prompt('Rename list', list.name); if (n) { list.name = cap(n.trim()); save(); render(); } break; }
    case 'clear-history':
      if (confirm('Forget all bought-before items on this list?')) { snapshot(); list.items = list.items.filter((i) => i.active); save(); render(); }
      break;
    case 'delete-list':
      if (confirm(`Delete "${list.name}"?`)) { snapshot(); state.lists = state.lists.filter((l) => l !== list); save(); go(''); }
      break;
    case 'settings': $('#set-key').value = state.settings.key; $('#settings').showModal(); break;
    case 'install': if (installPrompt) { installPrompt.prompt(); installPrompt = null; $('#install-item').hidden = true; } break;
    case 'export': exportJSON(); break;
    case 'import': $('#import-file').click(); break;
  }
}

// ---------- wiring ----------
// Chrome offers the install prompt once per visit; keep it for the menu's "Install app".
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('#install-item').hidden = false; });
window.addEventListener('appinstalled', () => { installPrompt = null; $('#install-item').hidden = true; toast('Installed'); });
// Tapping the dark backdrop closes any dialog (phones have no Esc key).
document.addEventListener('click', (e) => { if (e.target instanceof HTMLDialogElement && e.target.open) e.target.close(); });
$('#back-btn').addEventListener('click', () => go(''));
$('#menu-btn').addEventListener('click', () => $('#menu').showModal());
$('#menu').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  $('#menu').close();
  menuAction(btn.dataset.action);
});
$('#settings-save').addEventListener('click', () => {
  state.settings.key = $('#set-key').value.trim();
  save(); $('#settings').close(); toast('Saved');
});
$('#settings-close').addEventListener('click', () => $('#settings').close());
$('#import-file').addEventListener('change', (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ''; });
$('#photo-file').addEventListener('change', (e) => { if (e.target.files[0]) handlePhoto(e.target.files[0]); e.target.value = ''; });
$('#photo-btn').addEventListener('click', () => $('#photo-file').click());
$('#add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#add-input');
  const list = listById(currentListId);
  if (!list || !input.value.trim()) return;
  snapshot();
  const { added, dupes } = addItems(list, split(input.value));
  input.value = '';
  save(); render();
  if (dupes.length) toast(`${dupes.join(', ')} already on list`);
  else if (added.length > 1) toast(`Added ${added.length} items`);
});
$('#mic-btn').addEventListener('click', startListening);
$('#sheet-cancel').addEventListener('click', cancelListening);
window.addEventListener('hashchange', route);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.target.matches('input')) { e.preventDefault(); toast(undo() ? 'Undone' : 'Nothing to undo'); render(); }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

// exposed for console testing
window.KeepVoice = { execute, state, handleUtterance, handlePhoto, fallbackActions, loadSeed };

// First run loads the starter list. "#seed" merges seed.json into an existing install without duplicating.
if (location.hash === '#seed') { history.replaceState(null, '', location.pathname); loadSeed(); }
else if (!state.lists.length) loadSeed();
route();
})();
