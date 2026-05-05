// =============================================================================
// SQL Query Tool — v1.2 wire
// All submissions route through public.submit_sql(p_envelope jsonb) on the
// main Supabase project. The SP handles parsing, translation, execution, and
// audit-as-side-effect-of-execution per the architectural baseline §4.1.
//
// Frontend responsibility ends at envelope construction:
//   { sql: <raw text>, context: null }
//
// The SP's return shape passes through to the existing JSON renderer; we do
// not parse SQL on the client for the wire path. parseSql() and helpers below
// are retained for potential future client-side validation but are NOT on
// the wire path in v1.2 — to be cleaned up or repurposed in a later sprint.
// =============================================================================

// ----- Configuration ---------------------------------------------------------

const SUPABASE_URL = 'https://lkjskaygaijyelfqwoln.supabase.co';
const SUPABASE_KEY = 'sb_publishable_P78xr2RFEkj-3-n0ZB0XdA_KMFgu_Ji';

// ----- Errors ----------------------------------------------------------------

class ParseError extends Error {
  constructor(message) { super(message); this.name = 'ParseError'; }
}

class SqlError extends Error {
  constructor(message, code, hint, details) {
    super(message);
    this.name = 'SqlError';
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

// ----- SQL Parser ------------------------------------------------------------

function parseSql(raw) {
  const sql = raw.trim().replace(/;\s*$/, '');
  if (!sql) throw new ParseError('Empty query.');

  // RPC: SELECT name(args) — anchored at start AND end, the rest must be parens.
  const rpcMatch = sql.match(/^SELECT\s+(\w+)\s*\(([\s\S]*)\)\s*$/i);
  if (rpcMatch) {
    return {
      kind: 'rpc',
      function: rpcMatch[1],
      args: parseRpcArgs(rpcMatch[2])
    };
  }

  // SELECT FROM
  const selectMatch = sql.match(/^SELECT\s+([\s\S]+?)\s+FROM\s+(\w+)\s*([\s\S]*)$/i);
  if (selectMatch) {
    const [, cols, table, restRaw] = selectMatch;
    const rest = restRaw.trim();

    let where, orderBy, limit;

    // LIMIT N (must be at end)
    const limitMatch = rest.match(/\bLIMIT\s+(\d+)\s*$/i);
    let beforeLimit = rest;
    if (limitMatch) {
      limit = limitMatch[1];
      beforeLimit = rest.slice(0, rest.length - limitMatch[0].length).trim();
    }

    // ORDER BY ...
    const orderMatch = beforeLimit.match(/\bORDER\s+BY\s+([\s\S]+)$/i);
    let beforeOrder = beforeLimit;
    if (orderMatch) {
      orderBy = orderMatch[1].trim();
      beforeOrder = beforeLimit.slice(0, beforeLimit.length - orderMatch[0].length).trim();
    }

    // WHERE ...
    const whereMatch = beforeOrder.match(/\bWHERE\s+([\s\S]+)$/i);
    if (whereMatch) {
      where = whereMatch[1].trim();
      const beforeWhere = beforeOrder.slice(0, beforeOrder.length - whereMatch[0].length).trim();
      if (beforeWhere) {
        throw new ParseError(`Unexpected text before WHERE: "${beforeWhere}"`);
      }
    } else if (beforeOrder.length > 0) {
      throw new ParseError(`Unexpected text after table name: "${beforeOrder}"`);
    }

    return { kind: 'select', columns: cols.trim(), table, where, orderBy, limit };
  }

  throw new ParseError(
    'Unsupported query pattern.\n\n' +
    'Supported:\n' +
    '  • SELECT cols FROM table [WHERE col = val] [ORDER BY col] [LIMIT n]\n' +
    '  • SELECT function_name(p_arg := value, ...)'
  );
}

// Split a string at top-level occurrences of `separator`,
// respecting single-quoted strings and (), [], {} bracket nesting.
function splitTopLevel(s, separator) {
  const out = [];
  let depth = 0;
  let inQuote = false;
  let start = 0;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === "'" && s[i + 1] === "'") { i++; continue; }
      if (c === "'") inQuote = false;
      continue;
    }
    if (c === "'") { inQuote = true; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === separator) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

// Split on a top-level keyword (e.g. AND, OR), respecting quotes and brackets.
function splitTopLevelKeyword(s, keyword) {
  const out = [];
  let buf = '';
  let inQuote = false;
  let depth = 0;
  let i = 0;

  while (i < s.length) {
    const c = s[i];
    if (inQuote) {
      buf += c;
      if (c === "'" && s[i + 1] === "'") { buf += s[i + 1]; i += 2; continue; }
      if (c === "'") inQuote = false;
      i++;
      continue;
    }
    if (c === "'") { buf += c; inQuote = true; i++; continue; }
    if (c === '(' || c === '[' || c === '{') { buf += c; depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') { buf += c; depth--; i++; continue; }

    if (depth === 0 && /\s/.test(c)) {
      const m = s.slice(i).match(new RegExp(`^\\s+${keyword}(?=\\s)`, 'i'));
      if (m) {
        out.push(buf.trim());
        buf = '';
        i += m[0].length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function parseRpcArgs(argsStr) {
  argsStr = argsStr.trim();
  if (!argsStr) return {};

  const args = splitTopLevel(argsStr, ',');
  const result = {};

  for (const arg of args) {
    const trimmed = arg.trim();
    if (!trimmed) continue;

    // Find := at top level.
    let assignIdx = -1;
    let depth = 0;
    let inQuote = false;
    for (let i = 0; i < trimmed.length - 1; i++) {
      const c = trimmed[i];
      if (inQuote) {
        if (c === "'" && trimmed[i + 1] === "'") { i++; continue; }
        if (c === "'") inQuote = false;
        continue;
      }
      if (c === "'") { inQuote = true; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (depth === 0 && c === ':' && trimmed[i + 1] === '=') {
        assignIdx = i;
        break;
      }
    }

    if (assignIdx === -1) {
      throw new ParseError(
        'RPC arguments must use named syntax: p_arg := value\n' +
        `Got: ${trimmed}`
      );
    }

    const name = trimmed.slice(0, assignIdx).trim();
    const value = trimmed.slice(assignIdx + 2).trim();
    if (!/^\w+$/.test(name)) throw new ParseError(`Invalid argument name: ${name}`);
    result[name] = parseValue(value);
  }
  return result;
}

function parseValue(raw) {
  const v = raw.trim();
  if (!v) throw new ParseError('Empty value.');

  // Type cast: <expr>::<type>
  // Handle this only when the :: is at the top level (not inside a string).
  const castIdx = findTopLevelDoubleColon(v);
  if (castIdx !== -1) {
    const inner = v.slice(0, castIdx).trim();
    const type = v.slice(castIdx + 2).trim().toLowerCase();
    if (type === 'json' || type === 'jsonb') {
      const innerVal = parseValue(inner);
      if (typeof innerVal === 'string') {
        try { return JSON.parse(innerVal); }
        catch (e) { throw new ParseError(`Invalid JSON in ::${type} cast: ${e.message}`); }
      }
      return innerVal;
    }
    // For other casts (text, int, uuid, etc.), pass the inner value through.
    return parseValue(inner);
  }

  // Quoted string
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") {
    return v.slice(1, -1).replace(/''/g, "'");
  }

  // Number
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);

  // Boolean
  if (/^true$/i.test(v)) return true;
  if (/^false$/i.test(v)) return false;

  // NULL
  if (/^null$/i.test(v)) return null;

  // ARRAY[...]
  const arrayMatch = v.match(/^ARRAY\s*\[([\s\S]*)\]$/i);
  if (arrayMatch) {
    const inner = arrayMatch[1].trim();
    if (!inner) return [];
    return splitTopLevel(inner, ',').map(parseValue);
  }

  throw new ParseError(`Cannot parse value: ${v}`);
}

function findTopLevelDoubleColon(s) {
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === "'" && s[i + 1] === "'") { i++; continue; }
      if (c === "'") inQuote = false;
      continue;
    }
    if (c === "'") { inQuote = true; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === ':' && s[i + 1] === ':') {
      // Take the LAST top-level :: as the cast operator
      // (so 'foo'::text::jsonb works — but rare, and the recursive call handles it)
      // Actually: take the last to peel outermost cast first.
      let last = i;
      for (let j = i + 2; j < s.length - 1; j++) {
        const cj = s[j];
        if (inQuote) {
          if (cj === "'" && s[j + 1] === "'") { j++; continue; }
          if (cj === "'") inQuote = false;
          continue;
        }
        if (cj === "'") { inQuote = true; continue; }
        if (cj === '(' || cj === '[' || cj === '{') depth++;
        else if (cj === ')' || cj === ']' || cj === '}') depth--;
        else if (depth === 0 && cj === ':' && s[j + 1] === ':') {
          last = j;
        }
      }
      return last;
    }
  }
  return -1;
}

// ----- WHERE clause parsing --------------------------------------------------

function parseWhere(where) {
  const parts = splitTopLevelKeyword(where, 'AND');
  const conditions = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    let m;

    // IS NOT NULL
    if (m = trimmed.match(/^(\w+)\s+IS\s+NOT\s+NULL$/i)) {
      conditions.push([m[1], 'not.is', 'null']); continue;
    }
    // IS NULL
    if (m = trimmed.match(/^(\w+)\s+IS\s+NULL$/i)) {
      conditions.push([m[1], 'is', 'null']); continue;
    }
    // LIKE / ILIKE
    if (m = trimmed.match(/^(\w+)\s+(LIKE|ILIKE)\s+([\s\S]+)$/i)) {
      const valueStr = stripQuotes(m[3].trim()).replace(/%/g, '*');
      conditions.push([m[1], m[2].toLowerCase(), valueStr]);
      continue;
    }
    // IN (...)
    if (m = trimmed.match(/^(\w+)\s+IN\s*\(([\s\S]+)\)$/i)) {
      const items = splitTopLevel(m[2], ',').map(x => stripQuotes(x.trim()));
      conditions.push([m[1], 'in', `(${items.join(',')})`]);
      continue;
    }
    // col OP value
    if (m = trimmed.match(/^(\w+)\s*(=|!=|<>|<=|>=|<|>)\s*([\s\S]+)$/)) {
      const opMap = { '=': 'eq', '!=': 'neq', '<>': 'neq', '<': 'lt', '>': 'gt', '<=': 'lte', '>=': 'gte' };
      conditions.push([m[1], opMap[m[2]], stripQuotes(m[3].trim())]);
      continue;
    }

    throw new ParseError(`Cannot parse WHERE clause: ${trimmed}`);
  }
  return conditions;
}

function stripQuotes(v) {
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

// ----- PostgREST URL/body builders -------------------------------------------

function buildSelectUrl(parsed) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${parsed.table}`);

  const cols = parsed.columns.replace(/\s+/g, '');
  if (cols && cols !== '*') url.searchParams.set('select', cols);

  if (parsed.where) {
    for (const [col, op, val] of parseWhere(parsed.where)) {
      url.searchParams.append(col, `${op}.${val}`);
    }
  }

  if (parsed.orderBy) {
    const orders = parsed.orderBy.split(',').map(s => {
      const parts = s.trim().split(/\s+/);
      const col = parts[0];
      const dir = (parts[1] || 'asc').toLowerCase();
      if (dir !== 'asc' && dir !== 'desc') throw new ParseError(`Invalid order direction: ${dir}`);
      return `${col}.${dir}`;
    });
    url.searchParams.set('order', orders.join(','));
  }

  if (parsed.limit) url.searchParams.set('limit', parsed.limit);

  return url.toString();
}

// ----- Execution -------------------------------------------------------------

async function runEnvelope(rawSql, signal) {
  // v1.2: build envelope per architectural baseline §4.4 and POST to submit_sql.
  // The SP owns parsing, translation, execution, and audit. Frontend does not
  // pre-parse the SQL — whatever the user types goes into the envelope verbatim.
  const envelope = {
    sql: rawSql,
    context: null
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/submit_sql`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ p_envelope: envelope }),
    signal
  });
  return handleResponse(res);
}

async function handleResponse(res) {
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch (e) { data = text; }
  }

  if (!res.ok) {
    if (data && typeof data === 'object') {
      throw new SqlError(
        data.message || data.msg || `HTTP ${res.status}`,
        data.code,
        data.hint,
        data.details
      );
    }
    throw new SqlError(`HTTP ${res.status}: ${data || res.statusText}`);
  }

  // PostgREST normally doesn't set a Warning header, but the spec defines a
  // warning result shape so we surface one when it does appear (per RFC 7234).
  const warning = res.headers && res.headers.get ? res.headers.get('Warning') : null;
  return { data, warning };
}

// ----- SQL display formatter -------------------------------------------------

function formatSql(sql) {
  let out = sql.trim().replace(/;\s*$/, '');

  const majorKeywords = [
    'FROM', 'WHERE', 'ORDER\\s+BY', 'GROUP\\s+BY', 'HAVING', 'LIMIT', 'OFFSET',
    'JOIN', 'LEFT\\s+JOIN', 'RIGHT\\s+JOIN', 'INNER\\s+JOIN', 'OUTER\\s+JOIN', 'CROSS\\s+JOIN',
    'UNION\\s+ALL', 'UNION', 'INTERSECT', 'EXCEPT'
  ];
  for (const kw of majorKeywords) {
    out = out.replace(new RegExp(`\\s+(${kw})\\s+`, 'gi'), '\n$1 ');
  }

  out = out.replace(/\s+(AND|OR)\s+/gi, '\n  $1 ');

  out = out.replace(/^SELECT\s+([\s\S]+?)(\nFROM|\s+FROM)/i, (match, cols, rest) => {
    const colList = cols.split(',').map(c => c.trim()).filter(Boolean);
    if (colList.length > 3 || cols.length > 60) {
      const fromPart = rest.trim().startsWith('FROM') ? '\nFROM' : rest;
      return 'SELECT\n  ' + colList.join(',\n  ') + (fromPart.startsWith('\n') ? fromPart : '\n' + fromPart);
    }
    return match;
  });

  return out;
}

// ----- Result building (JSON shapes per v1.1 spec §2.2) ---------------------

function buildResultJson(data, warning) {
  if (warning) {
    return { result: 'warning', warning, rows: Array.isArray(data) ? data : [] };
  }
  if (Array.isArray(data) && data.length === 0) {
    return { result: 'no_rows', message: 'Query executed, no rows returned' };
  }
  if (Array.isArray(data)) {
    return { result: 'rows', row_count: data.length, rows: data };
  }
  if (data === null || data === undefined) {
    return { result: 'no_rows', message: 'Query executed, no rows returned' };
  }
  return { result: 'scalar', value: data };
}

function buildErrorJson(err) {
  if (err instanceof ParseError) {
    return { result: 'parse_error', error: err.message };
  }
  // SqlError or other
  const error = { message: err.message };
  if (err.code) error.code = err.code;
  if (err.hint) error.hint = err.hint;
  if (err.details) error.details = err.details;
  return { result: 'error', error };
}

// ----- Chunking (v1.1 spec §3) -----------------------------------------------

const CHUNK_SIZE = 14000;
const CHUNK_WRAPPER = (m, n) =>
  `=== CHUNK ${m} of ${n} — concatenate all chunks in order, strip these markers, parse as JSON ===`;

// Splits a JSON string into chunks. Returns an array of { content, wrapper, index, total }.
// Single-chunk results have wrapper=null per spec §3.2.
function chunkJson(jsonString, chunkSize = CHUNK_SIZE) {
  if (jsonString.length <= chunkSize) {
    return [{ content: jsonString, wrapper: null, index: 1, total: 1 }];
  }
  const total = Math.ceil(jsonString.length / chunkSize);
  const chunks = [];
  for (let i = 0; i < total; i++) {
    chunks.push({
      content: jsonString.slice(i * chunkSize, (i + 1) * chunkSize),
      wrapper: CHUNK_WRAPPER(i + 1, total),
      index: i + 1,
      total
    });
  }
  return chunks;
}

// What goes on the clipboard for a given chunk: wrapper line + content, or just content
// if it's a single-chunk result (per spec §3.2: "the wrapper is omitted").
function chunkClipboardText(chunk) {
  return chunk.wrapper ? `${chunk.wrapper}\n${chunk.content}` : chunk.content;
}

// =============================================================================
// UI
// =============================================================================

// Only run UI code when the DOM is available (skipped in node test env).
if (typeof document !== 'undefined') initUI();

function initUI() {
const $ = id => document.getElementById(id);
const $sql = $('sql-input');
const $format = $('format-btn');
const $submit = $('submit-btn');
const $status = $('status');
const $result = $('result');

function autoResize() {
  $sql.style.height = 'auto';
  $sql.style.height = Math.max(140, Math.min($sql.scrollHeight + 2, 600)) + 'px';
}

function setStatus(state, text) {
  $status.dataset.state = state;
  $status.textContent = text;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function labelForResult(resultJson) {
  switch (resultJson.result) {
    case 'rows':        return `${resultJson.row_count} row${resultJson.row_count === 1 ? '' : 's'}`;
    case 'no_rows':     return 'No rows';
    case 'scalar':      return 'Scalar';
    case 'warning':     return 'Warning';
    case 'error':       return 'Error';
    case 'parse_error': return 'Parse error';
    default:            return 'Result';
  }
}

// Lightweight JSON syntax highlighter. Tokenises raw text and wraps tokens in
// classed spans; non-token gaps are HTML-escaped untouched. Tolerates partial
// JSON (mid-token chunk slices) — anything that doesn't match a token regex
// stays as plain escaped text without throwing.
function highlightJson(text) {
  const tokenRe = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    if (m.index > last) out += escapeHtml(text.slice(last, m.index));
    if (m[1]) {
      const cls = m[2] ? 'json-key' : 'json-string';
      out += `<span class="${cls}">${escapeHtml(m[1])}</span>`;
      if (m[2]) out += escapeHtml(m[2]);
    } else if (m[3]) {
      out += `<span class="${m[3] === 'null' ? 'json-null' : 'json-bool'}">${m[3]}</span>`;
    } else if (m[4]) {
      out += `<span class="json-number">${m[4]}</span>`;
    }
    last = tokenRe.lastIndex;
  }
  if (last < text.length) out += escapeHtml(text.slice(last));
  return out;
}

// ----- Result rendering (JSON, with chunking nav for large results) ---------
//
// Module-level state for the currently-rendered result so chunk navigation
// can mutate the view without rebuilding the card.

let currentChunks = [];
let currentChunkIndex = 0;
let currentResultLabel = '';
let currentIsError = false;
let lastCopyBtn = null;

function renderJsonResult(resultJson, isError) {
  const fullText = JSON.stringify(resultJson, null, 2);
  currentChunks = chunkJson(fullText);
  currentChunkIndex = 0;
  currentResultLabel = labelForResult(resultJson);
  currentIsError = !!isError;

  $result.innerHTML = '';
  const card = document.createElement('div');
  card.className = `result-card ${isError ? 'error' : 'success'}`;

  // Header wrapper holds the indicator+Copy row and (when chunked) a nav row.
  const header = document.createElement('div');
  header.className = 'result-header-wrap';

  const headerTop = document.createElement('div');
  headerTop.className = 'result-header';

  const labelEl = document.createElement('span');
  labelEl.className = 'result-label';
  labelEl.id = 'result-label';
  headerTop.appendChild(labelEl);

  const copyCurrentBtn = document.createElement('button');
  copyCurrentBtn.className = 'copy-btn';
  copyCurrentBtn.id = 'copy-current-btn';
  copyCurrentBtn.type = 'button';
  copyCurrentBtn.textContent = 'Copy';
  copyCurrentBtn.addEventListener('click', () => {
    const text = chunkClipboardText(currentChunks[currentChunkIndex]);
    copyToClipboard(text, copyCurrentBtn);
  });
  headerTop.appendChild(copyCurrentBtn);
  header.appendChild(headerTop);

  // The Copy current button is what auto-copy will flash to "Copied".
  lastCopyBtn = copyCurrentBtn;

  // Multi-chunk: second header row with prev/next nav and Copy next.
  if (currentChunks.length > 1) {
    const navRow = document.createElement('div');
    navRow.className = 'chunk-nav-row';

    const navLeft = document.createElement('div');
    navLeft.className = 'chunk-nav-left';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'chunk-nav-btn';
    prevBtn.id = 'chunk-prev-btn';
    prevBtn.type = 'button';
    prevBtn.textContent = '◀';
    prevBtn.setAttribute('aria-label', 'Previous chunk');
    prevBtn.addEventListener('click', () => navigateChunk(-1));
    navLeft.appendChild(prevBtn);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'chunk-nav-btn';
    nextBtn.id = 'chunk-next-btn';
    nextBtn.type = 'button';
    nextBtn.textContent = '▶';
    nextBtn.setAttribute('aria-label', 'Next chunk');
    nextBtn.addEventListener('click', () => navigateChunk(1));
    navLeft.appendChild(nextBtn);

    navRow.appendChild(navLeft);

    const copyNextBtn = document.createElement('button');
    copyNextBtn.className = 'copy-btn copy-next-btn';
    copyNextBtn.id = 'copy-next-btn';
    copyNextBtn.type = 'button';
    copyNextBtn.textContent = 'Copy next';
    copyNextBtn.addEventListener('click', copyNextChunk);
    navRow.appendChild(copyNextBtn);

    header.appendChild(navRow);
  }

  // Body: JSON viewer (syntax-highlighted)
  const body = document.createElement('div');
  body.className = 'result-body json-body';
  const pre = document.createElement('pre');
  pre.className = 'json-viewer';
  pre.id = 'json-viewer';
  body.appendChild(pre);

  card.appendChild(header);
  card.appendChild(body);
  $result.appendChild(card);

  updateChunkDisplay();

  // Auto-copy text is chunk 1's clipboard form (with wrapper marker if multi).
  return chunkClipboardText(currentChunks[0]);
}

function updateChunkDisplay() {
  if (currentChunks.length === 0) return;
  const chunk = currentChunks[currentChunkIndex];
  const labelEl = document.getElementById('result-label');
  const viewer = document.getElementById('json-viewer');
  if (!labelEl || !viewer) return;

  if (currentChunks.length > 1) {
    labelEl.textContent = `Chunk ${chunk.index} of ${chunk.total}`;
    labelEl.classList.add('chunk-indicator');

    const prevBtn = document.getElementById('chunk-prev-btn');
    const nextBtn = document.getElementById('chunk-next-btn');
    const copyNextBtn = document.getElementById('copy-next-btn');
    if (prevBtn) prevBtn.disabled = (currentChunkIndex === 0);
    if (nextBtn) nextBtn.disabled = (currentChunkIndex === currentChunks.length - 1);
    if (copyNextBtn) copyNextBtn.disabled = (currentChunkIndex === currentChunks.length - 1);
  } else {
    labelEl.textContent = currentResultLabel;
    labelEl.classList.remove('chunk-indicator');
  }

  viewer.innerHTML = highlightJson(chunk.content);
}

function navigateChunk(delta) {
  const next = currentChunkIndex + delta;
  if (next < 0 || next >= currentChunks.length) return;
  currentChunkIndex = next;
  updateChunkDisplay();
}

async function copyNextChunk() {
  if (currentChunkIndex >= currentChunks.length - 1) return;
  currentChunkIndex++;
  updateChunkDisplay();
  const btn = document.getElementById('copy-next-btn');
  const text = chunkClipboardText(currentChunks[currentChunkIndex]);
  await copyToClipboard(text, btn);
}

function clearAll() {
  if (currentAbort) {
    try { currentAbort.abort(); } catch (_) {}
    currentAbort = null;
  }
  $sql.value = '';
  $result.innerHTML = '';
  currentChunks = [];
  currentChunkIndex = 0;
  currentResultLabel = '';
  currentIsError = false;
  lastCopyBtn = null;
  $submit.disabled = false;
  $format.disabled = false;
  setStatus('ready', 'Ready');
  autoResize();
}

// Visual "Copied" state on a button, reverting to the button's original label
// after a beat. Original label captured on first flash so we can restore it
// for buttons whose default label isn't "Copy" (e.g. "Copy next").
function flashCopied(btn, label = 'Copied') {
  if (!btn) return;
  if (typeof btn._origLabel !== 'string') btn._origLabel = btn.textContent;
  btn.textContent = label;
  btn.classList.add('copied');
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => {
    btn.textContent = btn._origLabel;
    btn.classList.remove('copied');
  }, 1800);
}

// Manual copy (any Copy button click). Clipboard API first, execCommand fallback.
async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    flashCopied(btn);
    return true;
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    document.body.removeChild(ta);
    if (ok) flashCopied(btn);
    else if (btn) {
      const orig = btn._origLabel || btn.textContent;
      btn.textContent = 'Copy failed';
      setTimeout(() => { btn.textContent = orig; }, 1800);
    }
    return ok;
  }
}

// AbortController for the in-flight query. Submit cancels any prior fetch
// before starting a new one, and Clear cancels without starting a new one.
let currentAbort = null;

async function submit() {
  const raw = $sql.value;
  if (!raw.trim()) return;

  // Cancel any prior in-flight query before kicking off a new one.
  if (currentAbort) {
    try { currentAbort.abort(); } catch (_) {}
  }
  currentAbort = new AbortController();
  const signal = currentAbort.signal;

  // Queue clipboard write SYNCHRONOUSLY inside the user-gesture handler.
  // ClipboardItem with a Promise<Blob> preserves user activation across the
  // awaited fetch — necessary for iOS Safari, helpful elsewhere.
  let resolveCopyText, rejectCopyText;
  const copyTextPromise = new Promise((res, rej) => {
    resolveCopyText = res;
    rejectCopyText = rej;
  });

  let pendingClipboardWrite = null;
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof ClipboardItem === 'function') {
    try {
      pendingClipboardWrite = navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': copyTextPromise.then(t => new Blob([t], { type: 'text/plain' }))
        })
      ]);
    } catch (_) {
      pendingClipboardWrite = null;
    }
  }

  setStatus('running', 'Running…');
  $submit.disabled = true;
  $format.disabled = true;
  $result.innerHTML = '';
  lastCopyBtn = null;
  currentChunks = [];
  currentChunkIndex = 0;

  let resultJson = null;
  let isError = false;
  let bailed = false;

  try {
    // v1.2 wire: skip client-side parsing. Send raw SQL to submit_sql, which
    // owns parsing/translation/execution/audit per architectural baseline §4.1.
    const { data, warning } = await runEnvelope(raw, signal);
    resultJson = buildResultJson(data, warning);
  } catch (e) {
    if (e && e.name === 'AbortError') {
      bailed = true;
    } else {
      isError = true;
      resultJson = buildErrorJson(e);
    }
  }

  $submit.disabled = false;
  $format.disabled = false;
  setStatus('ready', 'Ready');
  currentAbort = null;

  if (bailed) {
    // Clear was pressed mid-query. Reject the queued clipboard promise so
    // the browser doesn't write anything — preserves whatever Paul had
    // copied previously, per spec §4 ("does not affect clipboard").
    rejectCopyText(new Error('cancelled'));
    if (pendingClipboardWrite) {
      try { await pendingClipboardWrite; } catch (_) {}
    }
    return;
  }

  const copyText = renderJsonResult(resultJson, isError);
  resolveCopyText(copyText);

  // Wait for queued write; fall back to writeText if it failed or wasn't supported.
  let copied = false;
  if (pendingClipboardWrite) {
    try { await pendingClipboardWrite; copied = true; }
    catch (_) {
      try { await navigator.clipboard.writeText(copyText); copied = true; } catch (_) {}
    }
  } else if (navigator.clipboard) {
    try { await navigator.clipboard.writeText(copyText); copied = true; } catch (_) {}
  }

  if (copied) flashCopied(lastCopyBtn);
}

// ----- Event wiring ----------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  $sql.addEventListener('input', autoResize);

  $sql.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = $sql.selectionStart;
      const end = $sql.selectionEnd;
      $sql.value = $sql.value.slice(0, start) + '  ' + $sql.value.slice(end);
      $sql.selectionStart = $sql.selectionEnd = start + 2;
      autoResize();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });

  $format.addEventListener('click', () => {
    $sql.value = formatSql($sql.value);
    autoResize();
  });

  $submit.addEventListener('click', submit);

  const $clear = document.getElementById('clear-btn');
  if ($clear) $clear.addEventListener('click', clearAll);

  setStatus('ready', 'Ready');
  autoResize();
});
} // end initUI

// Export for testing under Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseSql, parseRpcArgs, parseValue, parseWhere, splitTopLevel,
    splitTopLevelKeyword, formatSql, buildSelectUrl,
    buildResultJson, buildErrorJson, chunkJson, chunkClipboardText,
    CHUNK_SIZE, ParseError, SqlError,
    SUPABASE_URL, SUPABASE_KEY
  };
}
