'use strict';

/* Trade Journal UI. All trades and photos stay in IndexedDB on this device.
   Asset URLs are relative so the app works under /trade-journal/ on GitHub Pages. */

const SLOTS = [
  { id: 'weekly', label: 'Weekly', hint: 'Weekly chart' },
  { id: 'daily', label: 'Daily', hint: 'Daily chart' },
  { id: 'h4', label: '4H', hint: '4 hour chart' },
  { id: 'h1', label: '1H', hint: '1 hour chart' },
  { id: 'm30', label: '30m', hint: '30 minute chart' },
  { id: 'm15', label: '15m', hint: '15 minute chart' },
  { id: 'other', label: 'Other', hint: '5 minute and anything else' },
];

const SLOT_IDS = new Set(SLOTS.map((slot) => slot.id));
const NUMBER_FIELDS = new Set(['size', 'entry', 'exit', 'stopLoss', 'takeProfit', 'lastPrice', 'pnl']);
const PRICE_FIELDS = new Set(['entry', 'exit', 'stopLoss', 'takeProfit', 'lastPrice', 'pnl']);
const BLOCK_FIELDS = [
  ['setup', 'Setup', 'text'],
  ['reasoning', 'Reasoning', 'area'],
  ['sentiment', 'Sentiment', 'area'],
  ['emotions', 'Emotions', 'area'],
  ['lessons', 'Lessons', 'area'],
  ['notes', 'Notes', 'area'],
];

const priceFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lotFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const whenFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const state = { trades: [], images: [] };
const slotByTrade = new Map();
const urlCache = new Map();
const saveTimers = new Map();
let filter = 'open';
let locks = 0;
let lockY = 0;
let toastTimer = 0;

const viewer = {
  images: [],
  index: 0,
  scale: 1,
  tx: 0,
  ty: 0,
  returnFocus: null,
};

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function money(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function formatMoney(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '—';
  const abs = moneyFmt.format(Math.abs(n));
  if (n < 0) return `−${abs}`;
  if (n > 0) return `+${abs}`;
  return abs;
}

function signClass(n) {
  if (typeof n !== 'number' || n === 0) return '';
  return n > 0 ? 'pos' : 'neg';
}

/* XAUUSD: 1.00 lot = 100 oz, so 0.01 lot moves $1 per $1 of price. */
function contractMultiplier(market) {
  const symbol = String(market || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (symbol === 'XAUUSD' || symbol === 'XAU' || symbol === 'GOLD') return 100;
  return null;
}

function canAuto(trade) {
  return contractMultiplier(trade.market) != null;
}

function calcPnl(trade) {
  const mult = contractMultiplier(trade.market);
  if (mult == null) return null;
  if (typeof trade.entry !== 'number' || typeof trade.size !== 'number') return null;
  const mark = trade.status === 'closed' && typeof trade.exit === 'number' ? trade.exit : trade.lastPrice;
  if (typeof mark !== 'number') return null;
  const dir = trade.side === 'short' ? -1 : 1;
  return money((mark - trade.entry) * dir * trade.size * mult);
}

function applyAutoPnl(trade) {
  if (trade.pnlSource === 'manual') return;
  if (!canAuto(trade)) return;
  trade.pnl = calcPnl(trade);
}

function describe(trade) {
  return `${trade.market || 'Untitled'} ${trade.side === 'short' ? 'short' : 'long'}, ${trade.status}`;
}

function tradeById(id) {
  return state.trades.find((trade) => trade.id === id) || null;
}

function cardEl(id) {
  return document.querySelector(`.card[data-id="${cssEscape(id)}"]`);
}

function imagesFor(tradeId, slot) {
  return state.images
    .filter((image) => image.tradeId === tradeId && image.slot === slot)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function activeSlot(tradeId) {
  const chosen = slotByTrade.get(tradeId);
  if (chosen) return chosen;
  const found = SLOTS.find((slot) => state.images.some((image) => image.tradeId === tradeId && image.slot === slot.id));
  return found ? found.id : 'daily';
}

function slotMeta(id) {
  return SLOTS.find((slot) => slot.id === id) || SLOTS[SLOTS.length - 1];
}

function urlFor(image) {
  if (!urlCache.has(image.id)) urlCache.set(image.id, URL.createObjectURL(image.blob));
  return urlCache.get(image.id);
}

function dropUrl(id) {
  const url = urlCache.get(id);
  if (url) URL.revokeObjectURL(url);
  urlCache.delete(id);
}

function sumPnl(trades) {
  if (!trades.length) return 0;
  const nums = trades.map((trade) => trade.pnl).filter((n) => typeof n === 'number');
  if (!nums.length) return null;
  return money(nums.reduce((sum, n) => sum + n, 0));
}

function winRate(closed) {
  const decided = closed.filter((trade) => typeof trade.pnl === 'number');
  if (!decided.length) return null;
  return decided.filter((trade) => trade.pnl > 0).length / decided.length;
}

function sortedVisible() {
  const rows = state.trades.filter((trade) => filter === 'all' || trade.status === filter);
  const stamp = (trade) => {
    const raw = trade.status === 'closed' ? (trade.closeAt || trade.openAt) : trade.openAt;
    const ms = raw ? new Date(raw).getTime() : 0;
    return Number.isNaN(ms) ? 0 : ms;
  };
  return rows.slice().sort((a, b) => stamp(b) - stamp(a) || String(b.createdAt).localeCompare(String(a.createdAt)));
}

function displayField(trade, field) {
  if (field === 'size') return trade.size == null ? '' : lotFmt.format(trade.size);
  if (field === 'pnl') return formatMoney(trade.pnl);
  if (field === 'openAt' || field === 'closeAt') {
    if (!trade[field]) return '';
    const date = new Date(trade[field]);
    return Number.isNaN(date.getTime()) ? '' : whenFmt.format(date);
  }
  if (PRICE_FIELDS.has(field)) return trade[field] == null ? '' : priceFmt.format(trade[field]);
  return String(trade[field] || '').trim() ? trade[field] : '';
}

function updateSummary() {
  const open = state.trades.filter((trade) => trade.status === 'open');
  const closed = state.trades.filter((trade) => trade.status === 'closed');
  document.getElementById('stat-open').textContent = String(open.length);
  document.getElementById('stat-closed').textContent = String(closed.length);
  paintMoney('stat-realized', sumPnl(closed));
  paintMoney('stat-float', sumPnl(open));
  const rate = winRate(closed);
  const win = document.getElementById('stat-win');
  win.textContent = rate == null ? '—' : `${Math.round(rate * 100)}%`;
  win.className = '';
  document.getElementById('count-open').textContent = String(open.length);
  document.getElementById('count-closed').textContent = String(closed.length);
  document.getElementById('count-all').textContent = String(state.trades.length);
  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.filter === filter));
  });
}

function paintMoney(id, value) {
  const el = document.getElementById(id);
  el.textContent = formatMoney(value);
  el.className = signClass(value);
}

function paintEmpty() {
  const empty = document.getElementById('empty');
  const count = document.querySelectorAll('#list .card').length;
  empty.hidden = count !== 0;
  if (count) return;
  if (filter === 'closed') {
    empty.textContent = 'No closed trades yet. Tap Closed on a trade and it counts toward realized P&L and win rate.';
  } else if (filter === 'open') {
    empty.textContent = 'No open trades. Add one, or look under Closed.';
  } else {
    empty.textContent = 'No trades yet. Add your first one.';
  }
}

function updateFieldDisplay(trade, field) {
  const card = cardEl(trade.id);
  if (!card) return;
  const row = card.querySelector(`[data-field="${field}"]`);
  if (!row || row.classList.contains('editing')) return;
  const value = row.querySelector('.v');
  const text = displayField(trade, field);
  const isBlock = row.classList.contains('block');
  if (!text && (isBlock || field === 'market')) {
    value.textContent = field === 'market' ? 'Tap to name' : 'Tap to add';
    value.className = 'v placeholder';
  } else if (!text) {
    value.textContent = '—';
    value.className = 'v';
  } else {
    value.textContent = text;
    value.className = field === 'pnl' ? `v ${signClass(trade.pnl)}`.trim() : 'v';
  }
  if (field === 'market') card.setAttribute('aria-label', describe(trade));
}

function updatePnl(trade) {
  updateFieldDisplay(trade, 'pnl');
  const card = cardEl(trade.id);
  if (!card) return;
  const tag = card.querySelector('.pnl-tag');
  const usePrice = card.querySelector('[data-action="pnl-auto"]');
  const manual = trade.pnlSource === 'manual';
  if (tag) tag.hidden = !( !manual && canAuto(trade) && typeof trade.pnl === 'number');
  if (usePrice) usePrice.hidden = !(manual && canAuto(trade));
}

function updateSide(trade) {
  const card = cardEl(trade.id);
  if (!card) return;
  card.querySelectorAll('[data-action="side"]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.value === trade.side));
  });
  card.setAttribute('aria-label', describe(trade));
}

function updateStatus(trade) {
  const card = cardEl(trade.id);
  if (!card) return;
  card.dataset.status = trade.status;
  card.querySelectorAll('[data-action="status"]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.value === trade.status));
  });
  card.setAttribute('aria-label', describe(trade));
  updateFieldDisplay(trade, 'closeAt');
  updatePnl(trade);
}

function updateConfidence(trade) {
  const card = cardEl(trade.id);
  if (!card) return;
  card.querySelectorAll('[data-action="confidence"]').forEach((button) => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.value) === trade.confidence));
  });
}

function renderList() {
  const list = document.getElementById('list');
  const y = document.body.classList.contains('locked') ? null : window.scrollY;
  const rows = sortedVisible();
  list.replaceChildren(...rows.map(renderCard));
  paintEmpty();
  if (y != null) window.scrollTo(0, y);
}

function render() {
  updateSummary();
  renderList();
}

function fieldRow(trade, field, label, kind, extraClass) {
  const text = displayField(trade, field);
  const empty = !text;
  const valueClass = field === 'pnl' ? `v ${signClass(trade.pnl)}`.trim() : 'v';
  return h('div', {
    class: `field${extraClass ? ` ${extraClass}` : ''}`,
    role: 'button',
    tabindex: '0',
    'data-field': field,
    'data-kind': kind,
    'data-label': label,
    'aria-label': `${label}, ${empty ? 'empty' : text}`,
  }, [
    h('span', { class: 'k', text: label }),
    h('span', { class: empty ? 'v placeholder' : valueClass, text: empty ? (field === 'market' ? 'Tap to name' : '—') : text }),
  ]);
}

function fieldBlock(trade, field, label, kind) {
  const text = displayField(trade, field);
  return h('div', {
    class: 'block',
    role: 'button',
    tabindex: '0',
    'data-field': field,
    'data-kind': kind,
    'data-label': label,
    'aria-label': `${label}, ${text ? text : 'empty'}`,
  }, [
    h('span', { class: 'k', text: label }),
    h('span', { class: text ? 'v' : 'v placeholder', text: text || 'Tap to add' }),
  ]);
}

function renderCard(trade) {
  const card = h('article', {
    class: 'card',
    role: 'listitem',
    'data-id': trade.id,
    'data-status': trade.status,
    'aria-label': describe(trade),
  });

  card.append(
    fieldRow(trade, 'market', 'Market', 'text', 'market'),
    h('div', { class: 'pair' }, [
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Side' }, [
        h('button', { type: 'button', class: 'long', 'data-action': 'side', 'data-value': 'long', 'aria-pressed': String(trade.side === 'long'), text: 'Long' }),
        h('button', { type: 'button', class: 'short', 'data-action': 'side', 'data-value': 'short', 'aria-pressed': String(trade.side === 'short'), text: 'Short' }),
      ]),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Status' }, [
        h('button', { type: 'button', class: 'open', 'data-action': 'status', 'data-value': 'open', 'aria-pressed': String(trade.status === 'open'), text: 'Open' }),
        h('button', { type: 'button', class: 'closed', 'data-action': 'status', 'data-value': 'closed', 'aria-pressed': String(trade.status === 'closed'), text: 'Closed' }),
      ]),
    ]),
    h('div', { class: 'size-row' }, [
      h('button', { type: 'button', class: 'step', 'data-action': 'size-dec', 'aria-label': 'Decrease lot size', text: '−' }),
      fieldRow(trade, 'size', 'Size (lots)', 'number'),
      h('button', { type: 'button', class: 'step', 'data-action': 'size-inc', 'aria-label': 'Increase lot size', text: '+' }),
    ]),
  );

  for (const [field, label] of [
    ['entry', 'Entry'],
    ['exit', 'Exit'],
    ['stopLoss', 'Stop loss'],
    ['takeProfit', 'Take profit'],
    ['lastPrice', 'Last price'],
  ]) {
    card.append(fieldRow(trade, field, label, 'number'));
  }

  const manual = trade.pnlSource === 'manual';
  const showTag = !manual && canAuto(trade) && typeof trade.pnl === 'number';
  const pnlLabel = h('span', { class: 'k' }, ['P&L', h('span', { class: 'pnl-tag', text: 'from price' })]);
  pnlLabel.querySelector('.pnl-tag').hidden = !showTag;
  const pnlValue = displayField(trade, 'pnl');
  const pnlRow = h('div', {
    class: 'field',
    role: 'button',
    tabindex: '0',
    'data-field': 'pnl',
    'data-kind': 'number',
    'data-label': 'P&L',
    'aria-label': `P&L, ${pnlValue}`,
  }, [
    pnlLabel,
    h('span', { class: `v ${signClass(trade.pnl)}`.trim(), text: pnlValue }),
  ]);
  card.append(h('div', { class: 'pnl-line' }, [
    pnlRow,
    h('button', {
      type: 'button',
      class: 'linkish',
      'data-action': 'pnl-auto',
      text: 'Use price',
      hidden: !(manual && canAuto(trade)),
    }),
  ]));

  card.append(fieldRow(trade, 'openAt', 'Opened', 'datetime'));
  card.append(fieldRow(trade, 'closeAt', 'Closed', 'datetime'));

  const journal = h('div', { class: 'journal' });
  for (const [field, label, kind] of BLOCK_FIELDS) {
    if (field === 'emotions') {
      journal.append(confidenceBlock(trade));
    }
    journal.append(fieldBlock(trade, field, label, kind));
  }
  card.append(journal);

  const charts = h('section', { class: 'charts' });
  fillCharts(charts, trade);
  card.append(charts);
  card.append(h('button', { type: 'button', class: 'delete', 'data-action': 'delete', text: 'Delete trade' }));
  return card;
}

function confidenceBlock(trade) {
  const wrap = h('div', { class: 'confidence' });
  wrap.append(h('span', { class: 'k', text: 'Confidence' }));
  const row = h('div', { class: 'conf', role: 'group', 'aria-label': 'Confidence from 1 to 5' });
  for (let n = 1; n <= 5; n += 1) {
    row.append(h('button', {
      type: 'button',
      'data-action': 'confidence',
      'data-value': String(n),
      'aria-pressed': String(trade.confidence === n),
      'aria-label': `Confidence ${n} of 5`,
      text: String(n),
    }));
  }
  wrap.append(row);
  wrap.append(h('p', { class: 'conf-hint', text: '1 low · 5 high. Tap the selected number again to clear.' }));
  return wrap;
}

function fillCharts(section, trade) {
  const slotId = activeSlot(trade.id);
  const meta = slotMeta(slotId);
  const photos = imagesFor(trade.id, slotId);
  section.replaceChildren(h('h3', { text: 'Charts' }));
  const slots = h('div', { class: 'slots', role: 'group', 'aria-label': 'Chart timeframe' });
  for (const slot of SLOTS) {
    const count = state.images.filter((image) => image.tradeId === trade.id && image.slot === slot.id).length;
    slots.append(h('button', {
      type: 'button',
      class: 'slot',
      'data-action': 'slot',
      'data-value': slot.id,
      'aria-pressed': String(slot.id === slotId),
      text: count ? `${slot.label} ${count}` : slot.label,
    }));
  }
  section.append(slots);
  section.append(h('p', { class: 'slot-hint', text: `${meta.hint}. Tap a photo to view it.` }));
  const thumbs = h('div', { class: 'thumbs' });
  photos.forEach((image, index) => {
    const button = h('button', {
      type: 'button',
      class: 'thumb',
      'data-action': 'view',
      'data-image-id': image.id,
      'aria-label': `View ${meta.label} chart ${index + 1}`,
    });
    button.append(h('img', { src: urlFor(image), alt: '' }));
    thumbs.append(button);
  });
  const input = h('input', {
    type: 'file',
    accept: 'image/*',
    multiple: true,
    class: 'photo-input',
    'aria-label': `Add ${meta.hint} photo`,
  });
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    addPhotos(trade.id, slotId, files);
  });
  const add = h('label', { class: 'add-photo file-btn' }, ['Add', input]);
  thumbs.append(add);
  section.append(thumbs);
}

function parseNumber(raw, final) {
  const text = String(raw ?? '').trim().replace(/^\+/, '').replace(/[$,\s]/g, '');
  if (!text || text === '—') return { value: null };
  if (!final && (/^-?\d*\.$/.test(text) || text === '-' || text === '.')) return { pending: true };
  if (!/^-?\d+(\.\d+)?$/.test(text)) return final ? { error: 'Enter a number' } : { pending: true };
  const value = Number(text);
  if (!Number.isFinite(value)) return { error: 'Enter a number' };
  return { value };
}

function parseField(field, raw, final) {
  if (NUMBER_FIELDS.has(field)) {
    const parsed = parseNumber(raw, final);
    if (parsed.error || parsed.pending) return parsed;
    if (field === 'size' && final && !(parsed.value > 0)) return { error: 'Size must be greater than 0' };
    return parsed;
  }
  if (field === 'openAt' || field === 'closeAt') {
    const text = String(raw || '').trim();
    if (!text) return { value: null };
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return { error: 'Enter a valid date and time' };
    return { value: date.toISOString() };
  }
  const text = String(raw ?? '');
  return { value: final ? text.trim() : text };
}

function assignField(trade, field, value) {
  if (field === 'pnl') {
    if (value == null) {
      trade.pnlSource = 'auto';
      trade.pnl = null;
    } else {
      trade.pnlSource = 'manual';
      trade.pnl = money(value);
    }
    return;
  }
  if (field === 'size' && typeof value === 'number') trade.size = money(value);
  else trade[field] = value;
}

function editorValue(trade, field) {
  if (field === 'size') return trade.size == null ? '' : String(trade.size);
  if (PRICE_FIELDS.has(field)) return trade[field] == null ? '' : Number(trade[field]).toFixed(2);
  if (field === 'openAt' || field === 'closeAt') return toLocalInput(trade[field]);
  return trade[field] || '';
}

function toLocalInput(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function cancelScheduled(tradeId, field) {
  const key = `${tradeId}:${field}`;
  clearTimeout(saveTimers.get(key));
  saveTimers.delete(key);
}

function scheduleSave(trade, field) {
  const key = `${trade.id}:${field}`;
  clearTimeout(saveTimers.get(key));
  saveTimers.set(key, setTimeout(() => { saveTrade(trade); }, 400));
}

const saveQueues = new Map();

function saveTrade(trade) {
  const prev = saveQueues.get(trade.id) || Promise.resolve();
  const job = prev.then(async () => {
    const snapshot = JSON.parse(JSON.stringify(trade));
    snapshot.updatedAt = new Date().toISOString();
    trade.updatedAt = snapshot.updatedAt;
    await TJDB.putTrade(snapshot);
    noteSaved();
    return true;
  }).catch((err) => {
    console.error(err);
    toast(err && err.name === 'QuotaExceededError'
      ? 'This phone is out of room for more journal data.'
      : 'Could not save. Check that site storage is allowed.');
    return false;
  });
  saveQueues.set(trade.id, job);
  return job;
}

function noteSaved() {
  const el = document.getElementById('save-state');
  el.textContent = 'Saved';
  clearTimeout(noteSaved.timer);
  noteSaved.timer = setTimeout(() => { el.textContent = 'Saved on this phone'; }, 1200);
}

function beginEdit(row) {
  if (row.classList.contains('editing')) return;
  const card = row.closest('.card');
  const trade = tradeById(card && card.dataset.id);
  if (!trade) return;
  const field = row.dataset.field;
  const kind = row.dataset.kind;
  const snapshot = JSON.parse(JSON.stringify(trade));
  row.classList.add('editing');
  const box = row.querySelector('.v');
  const input = document.createElement(kind === 'area' ? 'textarea' : 'input');
  input.className = 'editor';
  input.setAttribute('aria-label', row.dataset.label || field);
  input.autocomplete = 'off';
  if (kind === 'number') {
    input.inputMode = field === 'pnl' ? 'text' : 'decimal';
    input.enterKeyHint = 'done';
    input.autocapitalize = 'off';
    input.spellcheck = false;
  } else if (kind === 'datetime') {
    input.type = 'datetime-local';
  } else if (kind === 'area') {
    input.enterKeyHint = 'enter';
    input.rows = 3;
  } else {
    input.enterKeyHint = 'done';
    if (field === 'market') {
      input.autocapitalize = 'characters';
      input.spellcheck = false;
    }
  }
  input.value = editorValue(trade, field);
  box.replaceChildren(input);
  input.focus();
  if (kind === 'area') {
    const grow = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 280)}px`;
    };
    grow();
    input.addEventListener('input', grow);
  } else if (kind !== 'datetime') {
    const initial = input.value;
    const selectAll = () => {
      if (document.activeElement === input && input.value === initial) input.select();
    };
    // iOS only honors select() after focus has settled, but never after typing starts.
    selectAll();
    setTimeout(selectAll, 40);
  }

  let closed = false;
  const close = (commit) => {
    if (closed) return;
    closed = true;
    row.classList.remove('editing');
    cancelScheduled(trade.id, field);
    if (!commit) {
      Object.assign(trade, snapshot);
      updateFieldDisplay(trade, field);
      updatePnl(trade);
      updateSummary();
      saveTrade(trade);
      return;
    }
    const parsed = parseField(field, input.value, true);
    if (parsed.error) {
      Object.assign(trade, snapshot);
      toast(parsed.error);
      updateFieldDisplay(trade, field);
      updatePnl(trade);
      return;
    }
    assignField(trade, field, parsed.value);
    applyAutoPnl(trade);
    updateFieldDisplay(trade, field);
    updatePnl(trade);
    updateSummary();
    if (field === 'market') card.setAttribute('aria-label', describe(trade));
    saveTrade(trade);
  };

  input.addEventListener('blur', () => close(true));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(false);
    } else if (event.key === 'Enter' && kind !== 'area') {
      event.preventDefault();
      input.blur();
    }
  });
  input.addEventListener('input', () => {
    const parsed = parseField(field, input.value, false);
    if (parsed.error || parsed.pending) return;
    assignField(trade, field, parsed.value);
    if (field !== 'pnl') applyAutoPnl(trade);
    updatePnl(trade);
    updateSummary();
    scheduleSave(trade, field);
  });
}

async function setSide(trade, side) {
  if (trade.side === side) return;
  trade.side = side;
  applyAutoPnl(trade);
  updateSide(trade);
  updatePnl(trade);
  updateSummary();
  await saveTrade(trade);
}

async function setStatus(trade, status) {
  if (trade.status === status) return;
  trade.status = status;
  if (status === 'closed' && !trade.closeAt) trade.closeAt = new Date().toISOString();
  applyAutoPnl(trade);
  const show = filter === 'all' || filter === status;
  if (!show) {
    const card = cardEl(trade.id);
    if (card) card.remove();
    paintEmpty();
  } else {
    updateStatus(trade);
  }
  updateSummary();
  await saveTrade(trade);
  toast(status === 'closed'
    ? 'Closed. It now counts toward realized P&L.'
    : 'Reopened. P&L counts as floating.');
}

async function stepSize(trade, direction) {
  const current = typeof trade.size === 'number' ? trade.size : 0;
  const next = money(current + direction * 0.01);
  if (!(next > 0)) return;
  trade.size = next;
  applyAutoPnl(trade);
  updateFieldDisplay(trade, 'size');
  updatePnl(trade);
  updateSummary();
  await saveTrade(trade);
}

async function setConfidence(trade, value) {
  trade.confidence = trade.confidence === value ? null : value;
  updateConfidence(trade);
  await saveTrade(trade);
}

async function usePricePnl(trade) {
  trade.pnlSource = 'auto';
  applyAutoPnl(trade);
  updatePnl(trade);
  updateSummary();
  await saveTrade(trade);
}

async function deleteTrade(trade) {
  const name = trade.market || 'Untitled';
  const side = trade.side === 'short' ? 'short' : 'long';
  const ok = await confirmSheet({
    title: 'Delete trade?',
    body: `Delete the ${name} ${side} trade? Chart photos on it are removed too. This cannot be undone.`,
    confirm: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await TJDB.deleteTrade(trade.id);
  } catch (err) {
    console.error(err);
    toast('Could not delete that trade.');
    return;
  }
  state.trades = state.trades.filter((row) => row.id !== trade.id);
  const removed = state.images.filter((image) => image.tradeId === trade.id);
  state.images = state.images.filter((image) => image.tradeId !== trade.id);
  removed.forEach((image) => dropUrl(image.id));
  slotByTrade.delete(trade.id);
  const card = cardEl(trade.id);
  if (card) card.remove();
  paintEmpty();
  updateSummary();
  toast('Trade deleted');
}

function handleAction(button) {
  const card = button.closest('.card');
  const trade = tradeById(card && card.dataset.id);
  if (!trade) return;
  const action = button.dataset.action;
  if (action === 'side') setSide(trade, button.dataset.value);
  else if (action === 'status') setStatus(trade, button.dataset.value);
  else if (action === 'size-dec') stepSize(trade, -1);
  else if (action === 'size-inc') stepSize(trade, 1);
  else if (action === 'confidence') setConfidence(trade, Number(button.dataset.value));
  else if (action === 'pnl-auto') usePricePnl(trade);
  else if (action === 'delete') deleteTrade(trade);
  else if (action === 'slot') {
    slotByTrade.set(trade.id, button.dataset.value);
    const section = card.querySelector('.charts');
    if (section) fillCharts(section, trade);
  } else if (action === 'view') {
    openViewer(trade, button.dataset.imageId, button);
  }
}

async function addPhotos(tradeId, slot, files) {
  if (!files.length) return;
  const trade = tradeById(tradeId);
  if (!trade) return;
  let added = 0;
  let failed = 0;
  for (const file of files) {
    if (file.size > 30 * 1024 * 1024) {
      failed += 1;
      continue;
    }
    try {
      const blob = await compressImage(file);
      const image = {
        id: uid(),
        tradeId,
        slot,
        blob,
        createdAt: new Date().toISOString(),
      };
      await TJDB.putImage(image);
      state.images.push(image);
      added += 1;
    } catch (err) {
      console.error(err);
      failed += 1;
    }
  }
  const card = cardEl(tradeId);
  const section = card && card.querySelector('.charts');
  if (section) fillCharts(section, trade);
  if (added && failed) toast(`Added ${added} photo${added === 1 ? '' : 's'}. ${failed} could not be read.`);
  else if (added) toast(`Added ${added} photo${added === 1 ? '' : 's'}`);
  else toast('Could not read that photo. Try a JPEG or PNG.');
}

async function compressImage(file) {
  const maxEdge = 1600;
  const bitmap = await decodeImage(file);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('compress'))), 'image/jpeg', 0.8);
    });
    return blob;
  } finally {
    if (bitmap.close) bitmap.close();
  }
}

async function decodeImage(file) {
  try {
    return await createImageBitmap(file);
  } catch (err) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Could not read that photo'));
        el.src = url;
      });
      return await createImageBitmap(img);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

function lockScroll() {
  if (locks === 0) {
    lockY = window.scrollY;
    document.body.style.top = `-${lockY}px`;
    document.body.classList.add('locked');
  }
  locks += 1;
}

function unlockScroll() {
  locks = Math.max(0, locks - 1);
  if (locks === 0) {
    document.body.classList.remove('locked');
    document.body.style.top = '';
    window.scrollTo(0, lockY);
  }
}

function confirmSheet({ title, body, confirm, danger }) {
  const modal = document.getElementById('modal');
  const ok = document.getElementById('modal-ok');
  const cancel = document.getElementById('modal-cancel');
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').textContent = body;
  ok.textContent = confirm;
  ok.classList.toggle('danger', !!danger);
  modal.hidden = false;
  lockScroll();
  return new Promise((resolve) => {
    const finish = (value) => {
      modal.hidden = true;
      unlockScroll();
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      document.getElementById('modal-backdrop').removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (event) => {
      if (event.key === 'Escape') finish(false);
      if (event.key !== 'Tab') return;
      const nodes = [cancel, ok];
      const first = nodes[0];
      const last = nodes[1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    document.getElementById('modal-backdrop').addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
    cancel.focus();
  });
}

function blankTrade() {
  const now = new Date().toISOString();
  return {
    id: uid(),
    market: 'XAUUSD',
    side: 'long',
    size: 0.01,
    entry: null,
    exit: null,
    stopLoss: null,
    takeProfit: null,
    lastPrice: null,
    pnl: null,
    pnlSource: 'auto',
    openAt: now,
    closeAt: null,
    status: 'open',
    setup: '',
    reasoning: '',
    sentiment: '',
    confidence: null,
    emotions: '',
    lessons: '',
    notes: '',
    createdAt: now,
    updatedAt: now,
  };
}

async function addTrade() {
  const trade = blankTrade();
  const ok = await saveTrade(trade);
  if (!ok) return;
  state.trades.push(trade);
  if (filter === 'closed') filter = 'open';
  render();
  const card = cardEl(trade.id);
  if (card) {
    card.classList.add('fresh');
    const bar = document.querySelector('.sticky-bar');
    const top = card.getBoundingClientRect().top + window.scrollY - ((bar ? bar.offsetHeight : 0) + 8);
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
}

function seedTrades() {
  return [
    {
      id: 'seed-xauusd-2026-11-10',
      market: 'XAUUSD',
      side: 'long',
      size: 0.01,
      entry: 4096.2,
      exit: null,
      stopLoss: null,
      takeProfit: null,
      lastPrice: 4122.34,
      pnl: 26.14,
      pnlSource: 'auto',
      // Snapshot 10 Nov 2026, 20:44 UTC-5.
      openAt: '2026-11-10T20:44:00-05:00',
      closeAt: null,
      status: 'open',
      setup: '',
      reasoning: '',
      sentiment: '',
      confidence: null,
      emotions: '',
      lessons: '',
      notes: '',
      createdAt: '2026-11-10T20:44:00-05:00',
      updatedAt: '2026-11-10T20:44:00-05:00',
    },
    {
      id: 'seed-xauusd-2026-11-11',
      market: 'XAUUSD',
      side: 'long',
      size: 0.01,
      entry: 4018.11,
      exit: null,
      stopLoss: null,
      takeProfit: null,
      lastPrice: 4048.66,
      pnl: 30.55,
      pnlSource: 'auto',
      // Snapshot 11 Nov 2026, 03:41 UTC+2.
      openAt: '2026-11-11T03:41:00+02:00',
      closeAt: null,
      status: 'open',
      setup: '',
      reasoning: '',
      sentiment: '',
      confidence: null,
      emotions: '',
      lessons: '',
      notes: '',
      createdAt: '2026-11-11T03:41:00+02:00',
      updatedAt: '2026-11-11T03:41:00+02:00',
    },
  ];
}

async function exportBackup() {
  const button = document.getElementById('export-btn');
  button.disabled = true;
  toast('Preparing backup…');
  try {
    const images = [];
    for (const image of state.images) {
      images.push({
        id: image.id,
        tradeId: image.tradeId,
        slot: image.slot,
        createdAt: image.createdAt,
        type: image.blob.type || 'image/jpeg',
        dataUrl: await blobToDataUrl(image.blob),
      });
    }
    const payload = {
      app: 'trade-journal',
      version: 1,
      exportedAt: new Date().toISOString(),
      trades: state.trades.map((trade) => ({ ...trade })),
      images,
    };
    const filename = `trade-journal-${new Date().toISOString().slice(0, 10)}.json`;
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const file = new File([blob], filename, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Trade Journal backup' });
        toast('Backup ready to save');
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Backup downloaded');
  } catch (err) {
    console.error(err);
    toast('Could not export the backup.');
  } finally {
    button.disabled = false;
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, '').replace(/^\+/, ''));
  return Number.isFinite(n) ? n : null;
}

function dateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sanitizeTrade(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('A trade in the backup is unreadable.');
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : uid();
  const side = String(raw.side || '').toLowerCase() === 'short' ? 'short' : 'long';
  const status = String(raw.status || '').toLowerCase() === 'closed' ? 'closed' : 'open';
  let confidence = numOrNull(raw.confidence);
  if (confidence != null) {
    confidence = Math.round(confidence);
    if (confidence < 1 || confidence > 5) confidence = null;
  }
  const text = (value) => (typeof value === 'string' ? value : '');
  return {
    id,
    market: text(raw.market).trim(),
    side,
    size: numOrNull(raw.size),
    entry: numOrNull(raw.entry),
    exit: numOrNull(raw.exit),
    stopLoss: numOrNull(raw.stopLoss),
    takeProfit: numOrNull(raw.takeProfit),
    lastPrice: numOrNull(raw.lastPrice),
    pnl: numOrNull(raw.pnl),
    pnlSource: raw.pnlSource === 'manual' ? 'manual' : 'auto',
    openAt: dateOrNull(raw.openAt),
    closeAt: dateOrNull(raw.closeAt),
    status,
    setup: text(raw.setup),
    reasoning: text(raw.reasoning),
    sentiment: text(raw.sentiment),
    confidence,
    emotions: text(raw.emotions),
    lessons: text(raw.lessons),
    notes: text(raw.notes),
    createdAt: dateOrNull(raw.createdAt) || new Date().toISOString(),
    updatedAt: dateOrNull(raw.updatedAt) || new Date().toISOString(),
  };
}

async function dataUrlToBlob(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new Error('A chart photo in the backup is unreadable.');
  }
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('A chart photo in the backup is unreadable.');
  return blob;
}

async function normalizeBackup(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.trades)) {
    throw new Error('That file is not a Trade Journal backup.');
  }
  if (data.app && data.app !== 'trade-journal') throw new Error('That file is not a Trade Journal backup.');
  if (typeof data.version === 'number' && data.version > 1) {
    throw new Error('This backup is from a newer Trade Journal.');
  }
  const trades = [];
  const seen = new Set();
  for (const raw of data.trades) {
    const trade = sanitizeTrade(raw);
    if (seen.has(trade.id)) {
      const index = trades.findIndex((row) => row.id === trade.id);
      trades.splice(index, 1);
    }
    seen.add(trade.id);
    trades.push(trade);
  }
  const images = [];
  let skipped = 0;
  for (const raw of Array.isArray(data.images) ? data.images : []) {
    if (!raw || typeof raw !== 'object' || !seen.has(raw.tradeId)) {
      skipped += 1;
      continue;
    }
    const blob = await dataUrlToBlob(raw.dataUrl);
    images.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
      tradeId: raw.tradeId,
      slot: SLOT_IDS.has(raw.slot) ? raw.slot : 'other',
      createdAt: dateOrNull(raw.createdAt) || new Date().toISOString(),
      blob,
    });
  }
  return { trades, images, skipped };
}

async function importBackup(file) {
  if (!file) return;
  if (file.size > 80 * 1024 * 1024) {
    toast('That backup is too large for this phone.');
    return;
  }
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    toast('That file is not a Trade Journal backup.');
    return;
  }
  let normalized;
  try {
    normalized = await normalizeBackup(data);
  } catch (err) {
    toast(err.message || 'Could not read that backup.');
    return;
  }
  const count = normalized.trades.length;
  const ok = await confirmSheet({
    title: 'Replace journal?',
    body: `This will replace every trade and chart on this phone with ${count} trade${count === 1 ? '' : 's'} from the backup.`,
    confirm: 'Replace',
    danger: true,
  });
  if (!ok) return;
  try {
    await TJDB.replaceAll(normalized.trades, normalized.images);
  } catch (err) {
    console.error(err);
    toast(err && err.name === 'QuotaExceededError'
      ? 'This phone is out of room for that backup. The journal was not changed.'
      : 'Could not import. The journal was not changed.');
    return;
  }
  for (const id of [...urlCache.keys()]) dropUrl(id);
  slotByTrade.clear();
  state.trades = await TJDB.listTrades();
  state.images = await TJDB.listImages();
  render();
  toast(normalized.skipped ? 'Backup imported. Some photos were skipped.' : 'Backup imported');
}

function resetZoom() {
  viewer.scale = 1;
  viewer.tx = 0;
  viewer.ty = 0;
  applyZoom();
}

function applyZoom() {
  if (viewer.scale <= 1) {
    viewer.scale = 1;
    viewer.tx = 0;
    viewer.ty = 0;
  } else {
    const stage = document.getElementById('viewer-stage');
    const rect = stage.getBoundingClientRect();
    const limitX = (rect.width * (viewer.scale - 1)) / 2 + 48;
    const limitY = (rect.height * (viewer.scale - 1)) / 2 + 48;
    viewer.tx = Math.min(limitX, Math.max(-limitX, viewer.tx));
    viewer.ty = Math.min(limitY, Math.max(-limitY, viewer.ty));
  }
  document.getElementById('viewer-img').style.transform = `translate(${viewer.tx}px, ${viewer.ty}px) scale(${viewer.scale})`;
}

function paintViewer() {
  const image = viewer.images[viewer.index];
  if (!image) return;
  const img = document.getElementById('viewer-img');
  const meta = slotMeta(image.slot);
  img.src = urlFor(image);
  img.alt = `${meta.label} chart`;
  document.getElementById('viewer-caption').textContent = `${meta.label} · ${viewer.index + 1} of ${viewer.images.length}`;
  const many = viewer.images.length > 1;
  document.getElementById('viewer-prev').hidden = !many;
  document.getElementById('viewer-next').hidden = !many;
  applyZoom();
}

function openViewer(trade, imageId, trigger) {
  const image = state.images.find((item) => item.id === imageId);
  if (!image) return;
  viewer.images = imagesFor(trade.id, image.slot);
  viewer.index = Math.max(0, viewer.images.findIndex((item) => item.id === imageId));
  viewer.returnFocus = trigger || null;
  resetZoom();
  const root = document.getElementById('viewer');
  const wasOpen = !root.hidden;
  root.hidden = false;
  if (!wasOpen) lockScroll();
  paintViewer();
  document.getElementById('viewer-close').focus();
}

function closeViewer() {
  const root = document.getElementById('viewer');
  if (root.hidden) return;
  root.hidden = true;
  document.getElementById('viewer-img').removeAttribute('src');
  unlockScroll();
  resetZoom();
  if (viewer.returnFocus && viewer.returnFocus.isConnected) viewer.returnFocus.focus();
}

function stepViewer(delta) {
  if (viewer.images.length < 2) return;
  viewer.index = (viewer.index + delta + viewer.images.length) % viewer.images.length;
  resetZoom();
  paintViewer();
}

function zoomBy(factor) {
  viewer.scale = Math.min(6, Math.max(1, viewer.scale * factor));
  applyZoom();
}

async function removeCurrentPhoto() {
  const image = viewer.images[viewer.index];
  if (!image) return;
  const ok = await confirmSheet({
    title: 'Remove photo?',
    body: 'This chart photo will be deleted from the trade on this phone.',
    confirm: 'Remove',
    danger: true,
  });
  if (!ok) return;
  try {
    await TJDB.deleteImage(image.id);
  } catch (err) {
    console.error(err);
    toast('Could not remove that photo.');
    return;
  }
  state.images = state.images.filter((item) => item.id !== image.id);
  dropUrl(image.id);
  const trade = tradeById(image.tradeId);
  const card = cardEl(image.tradeId);
  const section = card && card.querySelector('.charts');
  if (section && trade) fillCharts(section, trade);
  viewer.images = viewer.images.filter((item) => item.id !== image.id);
  if (!viewer.images.length) {
    closeViewer();
  } else {
    viewer.index = Math.min(viewer.index, viewer.images.length - 1);
    resetZoom();
    paintViewer();
  }
  toast('Photo removed');
}

function wireViewer() {
  const stage = document.getElementById('viewer-stage');
  const pointers = new Map();
  const starts = new Map();
  let gesture = null;
  let lastTap = 0;

  stage.addEventListener('pointerdown', (event) => {
    if (document.getElementById('viewer').hidden) return;
    try { stage.setPointerCapture(event.pointerId); } catch (err) { /* synthetic or already released */ }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    starts.set(event.pointerId, { x: event.clientX, y: event.clientY });
    gesture = null;
  });

  stage.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pts = [...pointers.values()];
    if (pts.length >= 2) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      if (!gesture || !gesture.pinch) {
        gesture = { pinch: true, dist, mid, scale: viewer.scale, tx: viewer.tx, ty: viewer.ty };
      }
      const rect = stage.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const scale = Math.min(6, Math.max(1, gesture.scale * (dist / gesture.dist)));
      const k = gesture.scale ? scale / gesture.scale : 1;
      viewer.scale = scale;
      viewer.tx = (mid.x - cx) - k * ((gesture.mid.x - cx) - gesture.tx);
      viewer.ty = (mid.y - cy) - k * ((gesture.mid.y - cy) - gesture.ty);
      applyZoom();
    } else if (pts.length === 1 && viewer.scale > 1) {
      if (!gesture || !gesture.pan) {
        gesture = { pan: true, x: pts[0].x, y: pts[0].y, tx: viewer.tx, ty: viewer.ty };
      }
      viewer.tx = gesture.tx + (pts[0].x - gesture.x);
      viewer.ty = gesture.ty + (pts[0].y - gesture.y);
      applyZoom();
    }
  });

  const endPointer = (event) => {
    const start = starts.get(event.pointerId);
    const moved = start ? Math.hypot(event.clientX - start.x, event.clientY - start.y) : 0;
    const pinching = pointers.size > 1;
    pointers.delete(event.pointerId);
    starts.delete(event.pointerId);
    gesture = null;
    if (pointers.size === 1) {
      const remaining = [...pointers.values()][0];
      gesture = { pan: true, x: remaining.x, y: remaining.y, tx: viewer.tx, ty: viewer.ty };
      return;
    }
    if (pinching || moved > 12) return;
    const now = Date.now();
    if (now - lastTap < 280) {
      viewer.scale = viewer.scale > 1 ? 1 : 2.5;
      viewer.tx = 0;
      viewer.ty = 0;
      applyZoom();
      lastTap = 0;
    } else {
      lastTap = now;
    }
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('wheel', (event) => {
    if (document.getElementById('viewer').hidden) return;
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.12 : 0.89);
  }, { passive: false });
  stage.addEventListener('gesturestart', (event) => event.preventDefault());

  document.getElementById('viewer-close').addEventListener('click', closeViewer);
  document.getElementById('viewer-remove').addEventListener('click', removeCurrentPhoto);
  document.getElementById('viewer-prev').addEventListener('click', () => stepViewer(-1));
  document.getElementById('viewer-next').addEventListener('click', () => stepViewer(1));
  document.getElementById('viewer-zoom-in').addEventListener('click', () => zoomBy(1.5));
  document.getElementById('viewer-zoom-out').addEventListener('click', () => zoomBy(1 / 1.5));
  document.getElementById('viewer-fit').addEventListener('click', resetZoom);
  document.addEventListener('keydown', (event) => {
    if (document.getElementById('viewer').hidden) return;
    if (event.key === 'Escape') closeViewer();
    else if (event.key === 'ArrowRight') stepViewer(1);
    else if (event.key === 'ArrowLeft') stepViewer(-1);
  });
}

function wire() {
  const list = document.getElementById('list');
  list.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (action && list.contains(action)) {
      handleAction(action);
      return;
    }
    if (event.target.closest('input, textarea, label, button')) return;
    const field = event.target.closest('.field, .block');
    if (field && list.contains(field) && field.dataset.field && !field.classList.contains('editing')) {
      beginEdit(field);
    }
  });
  list.addEventListener('keydown', (event) => {
    const field = event.target.closest('.field, .block');
    if (!field || !field.dataset.field || field.classList.contains('editing')) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      beginEdit(field);
    }
  });

  document.getElementById('filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    filter = button.dataset.filter;
    render();
  });
  document.getElementById('add-trade').addEventListener('click', addTrade);
  document.getElementById('export-btn').addEventListener('click', exportBackup);
  document.getElementById('import-file').addEventListener('change', (event) => {
    const [file] = event.target.files || [];
    event.target.value = '';
    importBackup(file);
  });
  document.getElementById('tip-dismiss').addEventListener('click', () => {
    try { localStorage.setItem('tj-hide-install-tip', '1'); } catch (err) { /* private mode */ }
    document.documentElement.classList.add('tip-off');
  });
  wireViewer();
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const base = new URL('./', document.baseURI);
  navigator.serviceWorker.register(new URL('sw.js', base).href, { scope: base.href }).catch((err) => {
    console.error('Service worker registration failed', err);
  });
}

async function boot() {
  try {
    const seeded = await TJDB.getMeta('seeded');
    let trades = await TJDB.listTrades();
    if (!seeded) {
      if (trades.length === 0) {
        for (const trade of seedTrades()) await TJDB.putTrade(trade);
      }
      await TJDB.setMeta('seeded', true);
      trades = await TJDB.listTrades();
    }
    state.trades = trades;
    state.images = await TJDB.listImages();
    let dirty = false;
    for (const trade of state.trades) {
      if (trade.pnlSource === 'manual' || !canAuto(trade)) continue;
      const next = calcPnl(trade);
      const same = (trade.pnl == null && next == null) || (typeof trade.pnl === 'number' && typeof next === 'number' && Math.round(trade.pnl * 100) === Math.round(next * 100));
      if (!same) {
        trade.pnl = next;
        dirty = true;
        await TJDB.putTrade(trade);
      }
    }
    if (dirty) state.trades = await TJDB.listTrades();
    wire();
    render();
    document.getElementById('booting').hidden = true;
    document.getElementById('app').hidden = false;
    registerSW();
  } catch (err) {
    console.error(err);
    document.getElementById('booting').hidden = true;
    const box = document.getElementById('boot-error');
    box.hidden = false;
    box.textContent = err && err.message ? err.message : 'Could not open the journal on this phone.';
  }
}

boot();
