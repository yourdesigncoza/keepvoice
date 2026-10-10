/* KeepVoice — single-user voice list app. No backend; state lives in localStorage. */
(() => {
'use strict';

const STORE_KEY = 'keepvoice.v1';
const UNDO_DEPTH = 15;
const COLORS = ['#2d2e31', '#5c2b29', '#614a19', '#635d19', '#345920', '#16504b',
                '#2d555e', '#1e3a5f', '#42275e', '#5b2245', '#442f19', '#3c3f43'];
const DEFAULT_SETTINGS = {
  engine: 'rules',
  key: '',
  model: 'google/gemini-3.1-flash-lite',
  lang: 'en-ZA',
  speak: false,
};
const ARTICLES = /^(?:a|an|some|the|my|more)\s+/i;
const SPLIT = /\s*(?:,|\band\b|\bplus\b|\balso\b|&)\s*/i;

// ---------- state ----------
let state = load();
let undoStack = [];
let currentListId = null;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.lists)) {
      s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
      return s;
    }
  } catch (e) { /* fall through */ }
  return { lists: [], settings: { ...DEFAULT_SETTINGS }, lastList: null };
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
const norm = (s) => s.toLowerCase().replace(/[^\w\s,]/g, ' ').replace(/\s+/g, ' ').trim();
const key = (s) => norm(s).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const listById = (id) => state.lists.find((l) => l.id === id);
const currentList = () => listById(currentListId) || listById(state.lastList) || state.lists[0] || null;

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

// ---------- mutations (every voice/typed/tap change goes through these) ----------
function createList(name) {
  const list = { id: uid(), name: cap(name.trim()) || 'Untitled', color: COLORS[0], items: [], created: Date.now() };
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

// ---------- action executor (shared by rules parser, LLM parser and UI) ----------
function execute(actions) {
  const msgs = [];
  for (const a of actions) {
    if (a.type === 'undo') { msgs.push(undo() ? 'Undone' : 'Nothing to undo'); continue; }
    if (a.type !== 'undo' && !msgs.snap) { snapshot(); msgs.snap = true; }

    if (a.type === 'new_list') {
      const l = createList(a.name);
      go('list/' + l.id);
      msgs.push(`Created ${l.name}`);
      continue;
    }
    if (a.type === 'open_list') {
      const l = findList(a.name);
      if (l) { go('list/' + l.id); msgs.push(`Opened ${l.name}`); }
      else msgs.push(`No list called ${a.name}`);
      continue;
    }

    let list = a.list ? findList(a.list) : currentList();
    if (!list && a.type === 'add') list = createList(a.list || 'Groceries');
    if (!list) { msgs.push('Open a list first'); continue; }

    if (a.type === 'add') {
      const { added, dupes } = addItems(list, a.items);
      if (added.length) msgs.push(`Added ${added.join(', ')} to ${list.name}`);
      if (dupes.length) msgs.push(`${dupes.join(', ')} already on list`);
    } else if (a.type === 'tick' || a.type === 'remove' || a.type === 'untick') {
      const done = [], missing = [];
      for (const name of a.items) {
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

// ---------- rules parser ----------
// Whole-utterance commands: matched before any "to <list>" target is stripped.
const NAV_RULES = [
  [/^undo( that| last)?$/, () => ({ type: 'undo' })],
  [/^(?:new|create|make|start)(?: a)?(?: new)? list(?: called| named)? (.+)$/, (m) => ({ type: 'new_list', name: m[1] })],
  [/^(?:open|go to|switch to|show|show me)(?: the| my)? (.+?)(?: list)?$/, (m) => ({ type: 'open_list', name: m[1] })],
  [/^(?:clear|empty)(?: the| my)?(?: whole)? list$/, () => ({ type: 'clear' })],
];
// Item commands: may carry a trailing "to/on <list>" target.
const ITEM_RULES = [
  [/^(?:untick|uncheck|put back|re-?add|add back|bring back)(?: the)? (.+)$/, (m) => ({ type: 'untick', items: split(m[1]) })],
  [/^(?:delete|remove|drop|take off|scrap|forget)(?: the)? (.+?)(?: off| from)?(?: the| my)?(?: list)?$/, (m) => ({ type: 'remove', items: split(m[1]) })],
  [/^(?:tick off|tick|check off|check|cross off|cross out|done with|done|got|bought|have|finished|mark off|mark)(?: the)? (.+?)(?: as done| off)?$/, (m) => ({ type: 'tick', items: split(m[1]) })],
  [/^(?:please )?(?:add|put|get|buy|need|i need|we need|i want|we want|also|and|pick up)(?: some| the| a| an)? (.+)$/, (m) => ({ type: 'add', items: split(m[1]) })],
  [/^(.+)$/, (m) => ({ type: 'add', items: split(m[1]) })],
];

function matchRules(rules, text) {
  for (const [re, fn] of rules) {
    const m = text.match(re);
    if (m) return fn(m);
  }
  return null;
}

function split(text) {
  return text.split(SPLIT).map((s) => s.trim()).filter(Boolean);
}

function parseRules(text) {
  let t = norm(text);
  const nav = matchRules(NAV_RULES, t);
  if (nav) return [nav];
  let list = null;
  // trailing "to/on/in (the|my) <list> (list)" → target list, only if it matches a real list
  const target = t.match(/\s+(?:to|on|in|onto)\s+(?:the\s+|my\s+)?(.+?)(?:\s+list)?$/);
  if (target) {
    const hit = findList(target[1]);
    if (target[1] === 'list' || target[1] === 'it') t = t.slice(0, target.index);
    else if (hit && score(target[1], hit.name) >= 2) { list = hit.name; t = t.slice(0, target.index); }
  }
  const a = matchRules(ITEM_RULES, t);
  if (!a) return [];
  if (list) a.list = list;
  return [a];
}

// ---------- LLM parser (optional) ----------
async function parseLLM(text) {
  const { key, model } = state.settings;
  const cur = currentList();
  const context = {
    lists: state.lists.map((l) => l.name),
    current_list: cur ? cur.name : null,
    active_items: cur ? cur.items.filter((i) => i.active).map((i) => i.name) : [],
    history_items: cur ? cur.items.filter((i) => !i.active).map((i) => i.name) : [],
  };
  const system = `You convert a spoken shopping/todo command into JSON actions.
Return ONLY {"actions":[...]}. Action types:
{"type":"add","items":["milk","eggs"],"list":"Groceries"} (list optional = current)
{"type":"tick","items":[...]} {"type":"untick","items":[...]} {"type":"remove","items":[...]}
{"type":"new_list","name":"..."} {"type":"open_list","name":"..."} {"type":"clear"} {"type":"undo"}
Items are short noun phrases, singular where natural, no articles. Match tick/remove names to existing items when close.
Context: ${JSON.stringify(context)}`;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
    }),
  });
  if (!res.ok) throw new Error('LLM ' + res.status);
  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  return Array.isArray(parsed.actions) ? parsed.actions : [];
}

async function handleUtterance(text) {
  if (!text.trim()) return;
  let actions;
  if (state.settings.engine === 'llm' && state.settings.key) {
    try { actions = await parseLLM(text); }
    catch (e) { console.warn(e); toast('LLM failed, using rules'); }
  }
  if (!actions || !actions.length) actions = parseRules(text);
  const msg = execute(actions) || "Didn't understand";
  toast(msg);
  if (state.settings.speak && 'speechSynthesis' in window) {
    speechSynthesis.speak(new SpeechSynthesisUtterance(msg));
  }
}

// ---------- speech recognition ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;

function startListening() {
  if (!SR) { toast('Speech recognition not supported in this browser'); return; }
  if (rec) { rec.stop(); return; }
  rec = new SR();
  rec.lang = state.settings.lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let finalText = '';
  $('#voice-text').textContent = '';
  $('#voice-status').textContent = 'Listening…';
  $('#voice-panel').hidden = false;
  $('#mic-btn').classList.add('live');
  rec.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    $('#voice-text').textContent = finalText || interim;
  };
  rec.onerror = (ev) => {
    if (ev.error !== 'aborted') toast('Mic error: ' + ev.error);
  };
  rec.onend = () => {
    rec = null;
    $('#mic-btn').classList.remove('live');
    $('#voice-panel').hidden = true;
    if (finalText) handleUtterance(finalText);
  };
  try { rec.start(); } catch (e) { toast('Could not start mic'); rec = null; }
}

function cancelListening() {
  if (rec) { rec.onend = null; rec.abort(); rec = null; }
  $('#mic-btn').classList.remove('live');
  $('#voice-panel').hidden = true;
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

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

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
  $('#title').textContent = list ? list.name : 'KeepVoice';
  document.body.style.background = list ? list.color : '';
  if (list) renderList(view, list); else renderHome(view);
}

function renderHome(view) {
  const cards = el('div', { className: 'cards' });
  for (const l of state.lists) {
    const active = l.items.filter((i) => i.active);
    const ul = el('ul', {}, ...active.slice(0, 5).map((i) => el('li', {}, '☐ ' + i.name)));
    if (active.length > 5) ul.append(el('li', { className: 'more' }, `+${active.length - 5} more`));
    if (!active.length) ul.append(el('li', { className: 'more' }, 'empty'));
    cards.append(el('div', { className: 'card', style: `background:${l.color}`, on: { click: () => go('list/' + l.id) } },
      el('h2', {}, l.name), ul));
  }
  cards.append(el('div', { className: 'card new', on: { click: newListPrompt } }, '+ New list'));
  view.append(cards);
  if (!state.lists.length) view.append(el('p', { className: 'empty' }, 'Tap + New list, or press the mic and say "new list groceries".'));
}

function renderList(view, list) {
  const active = list.items.filter((i) => i.active).sort((a, b) => a.created - b.created);
  const history = list.items.filter((i) => !i.active).sort((a, b) => b.lastDone - a.lastDone);
  const ul = el('ul', { className: 'items' });
  for (const item of active) {
    ul.append(el('li', { className: 'item' },
      el('input', { type: 'checkbox', on: { change: () => { snapshot(); tickItem(item); save(); render(); toast(`Ticked ${item.name}`); } } }),
      el('span', { className: 'name' }, item.name),
      el('button', { className: 'del', title: 'Remove', on: { click: () => { snapshot(); removeItem(list, item); save(); render(); } } }, '×')));
  }
  view.append(ul);
  if (!active.length) view.append(el('p', { className: 'empty' }, 'Nothing on the list. Tap a previous item below or say "add milk".'));
  if (history.length) {
    const chips = el('div', { className: 'chips' }, ...history.map((item) =>
      el('button', { className: 'chip', on: { click: () => { snapshot(); item.active = true; item.created = Date.now(); save(); render(); } } },
        item.name, el('small', {}, '×' + item.count))));
    view.append(el('section', { className: 'history' }, el('h3', {}, 'Previously bought — tap to add'), chips));
  }
  $('#history-list').replaceChildren(...history.map((i) => el('option', { value: i.name })));
}

function newListPrompt() {
  const name = prompt('List name');
  if (name) { snapshot(); const l = createList(name); save(); go('list/' + l.id); }
}

function pickColor(list) {
  const dlg = el('dialog', {}, el('h2', {}, 'Colour'));
  const row = el('div', { className: 'colors' });
  for (const c of COLORS) {
    row.append(el('button', { style: `background:${c}`, className: c === list.color ? 'sel' : '',
      on: { click: () => { list.color = c; save(); render(); dlg.close(); dlg.remove(); } } }));
  }
  dlg.append(row, el('div', { className: 'row' }, el('button', { className: 'text-btn', on: { click: () => { dlg.close(); dlg.remove(); } } }, 'Close')));
  document.body.append(dlg);
  dlg.showModal();
}

function exportJSON() {
  const blob = new Blob([JSON.stringify({ lists: state.lists }, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `keepvoice-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.lists)) throw new Error('no lists');
      snapshot();
      for (const l of data.lists) {
        const idx = state.lists.findIndex((x) => x.id === l.id);
        if (idx >= 0) state.lists[idx] = l; else state.lists.push(l);
      }
      save(); render(); toast(`Imported ${data.lists.length} lists`);
    } catch (e) { toast('Import failed: ' + e.message); }
  };
  reader.readAsText(file);
}

function openSettings() {
  const s = state.settings;
  $('#set-engine').value = s.engine;
  $('#set-key').value = s.key;
  $('#set-model').value = s.model;
  $('#set-read').checked = s.speak;
  $('#settings').showModal();
}

function menuAction(action) {
  const list = currentListId && listById(currentListId);
  const needsList = ['rename', 'color', 'clear-history', 'delete-list'];
  if (needsList.includes(action) && !list) { toast('Open a list first'); return; }
  switch (action) {
    case 'rename': { const n = prompt('Rename list', list.name); if (n) { list.name = cap(n.trim()); save(); render(); } break; }
    case 'color': pickColor(list); break;
    case 'clear-history':
      if (confirm('Remove all previously bought items from this list?')) { snapshot(); list.items = list.items.filter((i) => i.active); save(); render(); }
      break;
    case 'delete-list':
      if (confirm(`Delete "${list.name}"?`)) { snapshot(); state.lists = state.lists.filter((l) => l !== list); save(); go(''); }
      break;
    case 'settings': openSettings(); break;
    case 'export': exportJSON(); break;
    case 'import': $('#import-file').click(); break;
  }
}

// ---------- wiring ----------
$('#back-btn').addEventListener('click', () => go(''));
$('#menu-btn').addEventListener('click', () => $('#menu').showModal());
$('#menu').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  $('#menu').close();
  if (btn.dataset.action !== 'close') menuAction(btn.dataset.action);
});
$('#settings-save').addEventListener('click', () => {
  Object.assign(state.settings, {
    engine: $('#set-engine').value,
    key: $('#set-key').value.trim(),
    model: $('#set-model').value.trim() || DEFAULT_SETTINGS.model,
    speak: $('#set-read').checked,
  });
  save(); $('#settings').close(); toast('Saved');
});
$('#settings-close').addEventListener('click', () => $('#settings').close());
$('#import-file').addEventListener('change', (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ''; });
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
$('#voice-cancel').addEventListener('click', cancelListening);
window.addEventListener('hashchange', route);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.target.matches('input')) { e.preventDefault(); toast(undo() ? 'Undone' : 'Nothing to undo'); render(); }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

// expose for console/testing
window.KeepVoice = { parseRules, execute, state, handleUtterance };
route();
})();
