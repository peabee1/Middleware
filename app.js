// =============================================================================
// SQL Query Tool
// Translates a small SQL subset into Supabase PostgREST calls.
//
// Supported:
//   • SELECT cols FROM table [WHERE conditions] [ORDER BY cols] [LIMIT n]
//   • SELECT function_name(p_arg := value, ...)
//
// Not supported (out of scope per spec):
//   • DDL, multi-statement scripts, joins, subqueries, raw arbitrary SQL.
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

async function executeQuery(parsed) {
  if (parsed.kind === 'select') return runSelect(parsed);
  return runRpc(parsed);
}

async function runSelect(parsed) {
  const res = await fetch(buildSelectUrl(parsed), {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Accept': 'application/json'
    }
  });
  return handleResponse(res);
}

async function runRpc(parsed) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${parsed.function}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(parsed.args || {})
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

  return data;
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

// ----- Markdown rendering (for clipboard) ------------------------------------

function toMarkdown(data) {
  if (Array.isArray(data)) {
    if (data.length === 0) return 'Query executed, no rows returned.';
    return rowsToMarkdownTable(data);
  }
  if (data === null || data === undefined) return 'Query executed, no rows returned.';
  return '```json\n' + JSON.stringify(data, null, 2) + '\n```';
}

function rowsToMarkdownTable(rows) {
  const colSet = new Set();
  for (const row of rows) for (const k of Object.keys(row)) colSet.add(k);
  const cols = Array.from(colSet);

  const headerRow = '| ' + cols.join(' | ') + ' |';
  const sepRow = '| ' + cols.map(() => '---').join(' | ') + ' |';
  const dataRows = rows.map(row =>
    '| ' + cols.map(c => formatMarkdownCell(row[c])).join(' | ') + ' |'
  );
  return [headerRow, sepRow, ...dataRows].join('\n');
}

function formatMarkdownCell(v) {
  if (v === null || v === undefined) return '_null_';
  let s = (typeof v === 'object') ? '`' + JSON.stringify(v) + '`' : String(v);
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function errorToMarkdown(err) {
  const lines = ['```'];
  if (err.code) lines.push(`Code: ${err.code}`);
  lines.push(`Error: ${err.message}`);
  if (err.hint) lines.push(`Hint: ${err.hint}`);
  if (err.details) lines.push(`Details: ${err.details}`);
  lines.push('```');
  return lines.join('\n');
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

function renderTable(rows) {
  const colSet = new Set();
  for (const row of rows) for (const k of Object.keys(row)) colSet.add(k);
  const cols = Array.from(colSet);

  const wrapper = document.createElement('div');
  wrapper.className = 'table-wrapper';

  const table = document.createElement('table');
  table.className = 'result-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const c of cols) {
    const th = document.createElement('th');
    th.textContent = c;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const c of cols) {
      const td = document.createElement('td');
      const v = row[c];
      if (v === null || v === undefined) {
        td.innerHTML = '<span class="null">null</span>';
      } else if (typeof v === 'object') {
        const code = document.createElement('code');
        code.textContent = JSON.stringify(v);
        td.appendChild(code);
      } else {
        td.textContent = String(v);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrapper.appendChild(table);
  return wrapper;
}

function renderEmpty() {
  const div = document.createElement('div');
  div.className = 'empty-message';
  div.textContent = 'Query executed, no rows returned.';
  return div;
}

function renderScalar(data) {
  const pre = document.createElement('pre');
  pre.className = 'scalar';
  pre.textContent = JSON.stringify(data, null, 2);
  return pre;
}

function renderResult(data) {
  $result.innerHTML = '';

  let kind, content, copyText, label;
  if (Array.isArray(data) && data.length === 0) {
    kind = 'empty';
    label = 'No rows';
    content = renderEmpty();
    copyText = 'Query executed, no rows returned.';
  } else if (Array.isArray(data)) {
    kind = 'rows';
    label = `${data.length} row${data.length === 1 ? '' : 's'}`;
    content = renderTable(data);
    copyText = toMarkdown(data);
  } else if (data === null || data === undefined) {
    kind = 'empty';
    label = 'No result';
    content = renderEmpty();
    copyText = 'Query executed, no rows returned.';
  } else {
    kind = 'scalar';
    label = 'Result';
    content = renderScalar(data);
    copyText = toMarkdown(data);
  }

  const card = document.createElement('div');
  card.className = `result-card success ${kind}`;

  const header = document.createElement('div');
  header.className = 'result-header';
  const labelEl = document.createElement('span');
  labelEl.className = 'result-label';
  labelEl.textContent = label;
  const copyBtn = makeCopyButton(copyText);
  header.appendChild(labelEl);
  header.appendChild(copyBtn);

  const body = document.createElement('div');
  body.className = 'result-body';
  body.appendChild(content);

  card.appendChild(header);
  card.appendChild(body);
  $result.appendChild(card);
}

function renderError(err) {
  $result.innerHTML = '';
  const copyText = errorToMarkdown(err);

  const card = document.createElement('div');
  card.className = 'result-card error';

  const header = document.createElement('div');
  header.className = 'result-header';
  const labelWrap = document.createElement('span');
  labelWrap.className = 'result-label';
  labelWrap.textContent = 'Error';
  if (err.code) {
    const code = document.createElement('span');
    code.className = 'error-code';
    code.textContent = err.code;
    labelWrap.appendChild(code);
  }
  const copyBtn = makeCopyButton(copyText);
  header.appendChild(labelWrap);
  header.appendChild(copyBtn);

  const body = document.createElement('div');
  body.className = 'result-body error-body';

  const msg = document.createElement('div');
  msg.className = 'error-message';
  msg.textContent = err.message;
  body.appendChild(msg);

  if (err.hint) {
    const hint = document.createElement('div');
    hint.className = 'error-meta';
    hint.innerHTML = `<span class="meta-label">Hint</span><span class="meta-value">${escapeHtml(err.hint)}</span>`;
    body.appendChild(hint);
  }
  if (err.details) {
    const details = document.createElement('div');
    details.className = 'error-meta';
    details.innerHTML = `<span class="meta-label">Details</span><span class="meta-value">${escapeHtml(err.details)}</span>`;
    body.appendChild(details);
  }

  card.appendChild(header);
  card.appendChild(body);
  $result.appendChild(card);
}

function makeCopyButton(text) {
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.type = 'button';
  btn.textContent = 'Copy';
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 1400);
    } catch (e) {
      // Fallback: select-and-copy via a hidden textarea
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); btn.textContent = 'Copied'; }
      catch (_) { btn.textContent = 'Copy failed'; }
      document.body.removeChild(ta);
      setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
    }
  });
  return btn;
}

async function submit() {
  const raw = $sql.value;
  if (!raw.trim()) return;

  setStatus('running', 'Running…');
  $submit.disabled = true;
  $format.disabled = true;
  $result.innerHTML = '';

  try {
    const parsed = parseSql(raw);
    const data = await executeQuery(parsed);
    renderResult(data);
  } catch (e) {
    renderError(e);
  } finally {
    $submit.disabled = false;
    $format.disabled = false;
    setStatus('ready', 'Ready');
  }
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

  setStatus('ready', 'Ready');
  autoResize();
});
} // end initUI

// Export for testing under Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseSql, parseRpcArgs, parseValue, parseWhere, splitTopLevel,
    splitTopLevelKeyword, formatSql, toMarkdown, rowsToMarkdownTable,
    errorToMarkdown, buildSelectUrl, ParseError, SqlError,
    SUPABASE_URL, SUPABASE_KEY
  };
}
