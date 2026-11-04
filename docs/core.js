/** Data rules for the packing notebook. No storage, network, or DOM access. */
const ID_PATTERN = /^\d{8}$/;
const MAX_ROSTER = 50000;
const MAX_EVENTS = 250000;
const HEADER_NAMES = new Set(['端末番号', '管理番号', '端末管理番号', '旧端末番号', 'pc管理番号', 'device', 'deviceid', 'id']);

export function newState() {
  return { schemaVersion: 1, roster: [], records: [], events: [], box: '箱01', rosterName: '', updatedAt: null };
}

export function normalizeId(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s/g, '');
}

function headerName(value) {
  return String(value).normalize('NFKC').replace(/[\s_\-]/g, '').toLowerCase();
}

function delimiterFor(text) {
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') i += 1;
      else quoted = !quoted;
    } else if (!quoted) {
      if (c === '\t') return '\t';
      if (c === ',') return ',';
      if (c === '\n' || c === '\r') break;
    }
  }
  return ',';
}

function readDelimited(text, delimiter) {
  const rows = [];
  let row = [], field = '', quoted = false, closedQuote = false;
  const finishField = () => { row.push(field); field = ''; closedQuote = false; };
  const finishRow = () => { finishField(); if (row.some(cell => cell.trim() !== '')) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else { quoted = false; closedQuote = true; }
      } else field += c;
    } else if (c === delimiter) finishField();
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      finishRow();
    } else if (c === '"') {
      if (field.trim() !== '' || closedQuote) throw new Error('CSVの引用符を確認してください。');
      field = ''; quoted = true;
    } else if (closedQuote) {
      if (!/\s/.test(c)) throw new Error('CSVの引用符の後に区切り以外の文字があります。');
    } else field += c;
  }
  if (quoted) throw new Error('CSVの引用符が閉じられていません。');
  if (field !== '' || row.length || closedQuote) finishRow();
  return rows;
}

/** Parse a selected ID column only; unrelated numbers are never inferred as IDs. */
export function parseRoster(text) {
  if (typeof text !== 'string') throw new Error('番号一覧を文字列で指定してください。');
  if (text.length > 20000000) throw new Error('番号一覧が大きすぎます。端末番号の列だけにしてください。');
  const clean = text.replace(/^\uFEFF/, '').trim();
  if (!clean) return { ids: [], duplicates: 0, invalid: [] };
  const rows = readDelimited(clean, delimiterFor(clean));
  if (!rows.length) return { ids: [], duplicates: 0, invalid: [] };
  const headers = rows[0].map((cell, index) => HEADER_NAMES.has(headerName(cell)) ? index : -1).filter(index => index >= 0);
  if (headers.length > 1) throw new Error('端末番号に使える列が複数あります。照合する番号の列だけにしてください。');
  if (!headers.length && rows.some(row => row.length !== 1)) {
    throw new Error('複数列の一覧には「端末番号」の見出しが必要です。端末番号１列だけの一覧も読み込めます。');
  }
  const index = headers.length ? headers[0] : 0;
  const start = headers.length ? 1 : 0;
  const ids = [], invalid = [], seen = new Set();
  let duplicates = 0;
  for (let r = start; r < rows.length; r += 1) {
    const raw = rows[r][index] ?? '';
    const id = normalizeId(raw);
    if (!ID_PATTERN.test(id)) {
      const preview = String(raw).replace(/[\r\n\t]/g, ' ').slice(0, 60);
      invalid.push(`${r + 1}行目：${preview || '番号が空欄です'}`);
    } else if (seen.has(id)) duplicates += 1;
    else { seen.add(id); ids.push(id); }
  }
  if (ids.length > MAX_ROSTER) throw new Error('読み込める端末番号は50,000件までです。');
  return { ids, duplicates, invalid };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validBox(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 40 && !/[\u0000-\u001f\u007f]/.test(value);
}

function requireTimestamp(now) {
  if (!isTimestamp(now)) throw new Error('記録日時が正しくありません。端末の日時設定を確認してください。');
}

function cleanBox(value) {
  if (typeof value !== 'string') throw new Error('箱番号を入力してください。');
  const box = value.trim();
  if (!validBox(box)) throw new Error('箱番号は改行を含まない1～40文字で入力してください。');
  return box;
}

/** Returns a detached canonical state or throws. Never repairs an invalid backup silently. */
export function validateState(obj) {
  const invalid = () => { throw new Error('保存データの形式が正しくありません。正しいバックアップを選んでください。'); };
  if (!isObject(obj) || obj.schemaVersion !== 1 || !Array.isArray(obj.roster) || !Array.isArray(obj.records) || !Array.isArray(obj.events)) invalid();
  if (obj.roster.length > MAX_ROSTER || obj.records.length > MAX_ROSTER || obj.events.length > MAX_EVENTS) invalid();
  if (!validBox(obj.box) || typeof obj.rosterName !== 'string' || obj.rosterName.length > 200 || (obj.updatedAt !== null && !isTimestamp(obj.updatedAt))) invalid();
  const roster = [], ids = new Set();
  for (const id of obj.roster) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id) || ids.has(id)) invalid();
    ids.add(id); roster.push(id);
  }
  const records = [], packed = new Map();
  for (const entry of obj.records) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !ids.has(entry.id) || packed.has(entry.id) || !validBox(entry.box) || !isTimestamp(entry.packedAt)) invalid();
    const record = { id: entry.id, box: entry.box, packedAt: entry.packedAt };
    packed.set(record.id, record); records.push(record);
  }
  const events = [], replay = new Map();
  for (const event of obj.events) {
    if (!isObject(event) || !['pack', 'undo'].includes(event.type) || typeof event.id !== 'string' || !ID_PATTERN.test(event.id) || !validBox(event.box) || !isTimestamp(event.at)) invalid();
    const clean = { type: event.type, id: event.id, box: event.box, at: event.at };
    if (clean.type === 'pack') {
      if (replay.has(clean.id)) invalid();
      replay.set(clean.id, { id: clean.id, box: clean.box, packedAt: clean.at });
    } else {
      if (!replay.has(clean.id) || replay.get(clean.id).box !== clean.box) invalid();
      replay.delete(clean.id);
    }
    events.push(clean);
  }
  if (replay.size !== packed.size) invalid();
  for (const [id, entry] of replay) {
    const record = packed.get(id);
    if (!record || record.box !== entry.box || record.packedAt !== entry.packedAt) invalid();
  }
  return { schemaVersion: 1, roster, records, events, box: obj.box, rosterName: obj.rosterName, updatedAt: obj.updatedAt };
}

export function importRoster(state, ids, name = '') {
  const next = validateState(state);
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_ROSTER) throw new Error('読み込める端末番号がありません。8桁の番号一覧を選んでください。');
  const normalized = ids.map(normalizeId);
  if (normalized.some(id => !ID_PATTERN.test(id))) throw new Error('端末番号は8桁の数字で指定してください。');
  const roster = [...new Set(normalized)];
  const idSet = new Set(roster);
  const missing = next.records.filter(record => !idSet.has(record.id));
  if (missing.length) throw new Error(`梱包済みの端末 ${missing[0].id} が新しい一覧にありません。梱包記録を残せる一覧を選んでください。`);
  if (typeof name !== 'string' || name.length > 200) throw new Error('一覧の名前が長すぎます。200文字以内にしてください。');
  next.roster = roster;
  next.rosterName = name;
  return next;
}

export function lookup(state, value) {
  const id = normalizeId(value);
  if (!id) return { status: 'empty', id };
  if (!ID_PATTERN.test(id)) return { status: 'invalid', id };
  if (!state.roster.length) return { status: 'no-roster', id };
  if (!state.roster.includes(id)) return { status: 'not-found', id };
  const record = state.records.find(entry => entry.id === id);
  return record ? { status: 'packed', id, record: { ...record } } : { status: 'ready', id };
}

export function pack(state, value, box, now) {
  const next = validateState(state);
  requireTimestamp(now);
  const selectedBox = cleanBox(box);
  const result = lookup(next, value);
  const errors = {
    empty: '端末番号を読み取るか入力してください。',
    invalid: '端末番号は8桁の数字で入力してください。',
    'no-roster': '先に回収対象の番号一覧を読み込んでください。',
    'not-found': 'この番号は回収対象の一覧にありません。',
    packed: `この端末はすでに${result.record?.box || '箱'}に梱包済みです。`
  };
  if (result.status !== 'ready') throw new Error(errors[result.status]);
  if (next.events.length >= MAX_EVENTS) throw new Error('記録件数の上限に達しました。バックアップを書き出してください。');
  next.records.push({ id: result.id, box: selectedBox, packedAt: now });
  next.events.push({ type: 'pack', id: result.id, box: selectedBox, at: now });
  next.box = selectedBox;
  next.updatedAt = now;
  return next;
}

export function undoPack(state, value, now) {
  const next = validateState(state);
  requireTimestamp(now);
  const id = normalizeId(value);
  const index = next.records.findIndex(record => record.id === id);
  if (index < 0) throw new Error('取り消せる梱包記録がありません。');
  if (next.events.length >= MAX_EVENTS) throw new Error('記録件数の上限に達しました。バックアップを書き出してください。');
  const [record] = next.records.splice(index, 1);
  next.events.push({ type: 'undo', id, box: record.box, at: now });
  next.updatedAt = now;
  return next;
}

function csvCell(value) {
  let text = String(value ?? '');
  // Excel treats a leading formula character as executable input, even in quoted CSV.
  if (/^[\s]*[=+@\-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function exportCSV(state) {
  const current = validateState(state);
  const packed = new Map(current.records.map(record => [record.id, record]));
  const rows = [['端末番号', '梱包状況', '箱番号', '梱包日時（日本時間）']];
  for (const id of current.roster) {
    const record = packed.get(id);
    const time = record ? new Date(new Date(record.packedAt).getTime() + 9 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19) : '';
    rows.push([id, record ? '梱包済み' : '未梱包', record?.box || '', time]);
  }
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function boxSummary(state) {
  const counts = new Map();
  for (const record of state.records) counts.set(record.box, (counts.get(record.box) || 0) + 1);
  return [...counts].map(([box, count]) => ({ box, count })).sort((a, b) => a.box.localeCompare(b.box, 'ja', { numeric: true }));
}
