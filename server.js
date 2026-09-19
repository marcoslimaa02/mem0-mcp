const http = require('http');
const https = require('https');
const { parse: parseUrl } = require('url');

const PORT = process.env.PORT || 8000;
const MEM0_API_KEY = process.env.MEM0_API_KEY || '';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID || '';
const PROXY_SECRET = process.env.PROXY_SECRET || '';

const SECTORS = ['work', 'studies', 'random'];

// --- Daily usage tracking (the start of the orchestrator's rate-limit logic) ---
// Mem0 free tier: 1,000 searches/month (~33/day), 10,000 adds/month (~333/day).
// We apply a safety margin below the raw daily average, per the PLAN.md formula.
const SEARCH_DAILY_LIMIT = 30;
const ADD_DAILY_LIMIT = 300;

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

let usage = { date: todayKey(), search: 0, add: 0 };

function resetIfNewDay() {
  const t = todayKey();
  if (usage.date !== t) usage = { date: t, search: 0, add: 0 };
}

function callMem0Raw(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Authorization': 'Token ' + MEM0_API_KEY, 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: 'api.mem0.ai', path, method, headers }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(chunks || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, json: { raw: chunks } }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function callMem0(path, body) { return callMem0Raw('POST', path, body); }

const TOOLS = [
  { name: 'add_memory', description: 'Store a new memory for the user, tagged with a sector: work (Odoo/Lotts), studies (college), or random (everything else).',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'The memory text to store.' }, sector: { type: 'string', enum: SECTORS, description: 'Which sector this memory belongs to.' } }, required: ['text', 'sector'] } },
  { name: 'search_memories', description: 'Search stored memories for the user, optionally scoped to one sector. Subject to a daily budget; may be deferred if today\'s budget is used up.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, sector: { type: 'string', enum: SECTORS.concat(['all']), description: 'Limit to one sector, or all to search everything.' } }, required: ['query'] } },
  { name: 'consolidate_memories', description: 'Merge and compact all memories in a sector into fewer, denser memories, deleting the originals. Use occasionally, not on every conversation.',
    inputSchema: { type: 'object', properties: { sector: { type: 'string', enum: SECTORS } }, required: ['sector'] } },
  { name: 'get_usage', description: 'Check today\'s Mem0 usage so far (add_memory and search_memories call counts) against the daily budget, before deciding whether to make more calls.',
    inputSchema: { type: 'object', properties: {} } }
];

function sectorFilters(sector) {
  return (sector && sector !== 'all' && SECTORS.includes(sector))
    ? { user_id: DEFAULT_USER_ID, metadata: { sector: sector } }
    : { user_id: DEFAULT_USER_ID };
}

async function listSectorMemories(sector) {
  const r = await callMem0('/v3/memories/?page=1&page_size=100', { filters: sectorFilters(sector) });
  return (r.json && r.json.results) || [];
}

async function handleToolCall(name, args) {
  resetIfNewDay();

  if (name === 'get_usage') {
    return { content: [{ type: 'text', text: JSON.stringify({
      date: usage.date,
      search: { used: usage.search, limit: SEARCH_DAILY_LIMIT, remaining: Math.max(0, SEARCH_DAILY_LIMIT - usage.search) },
      add: { used: usage.add, limit: ADD_DAILY_LIMIT, remaining: Math.max(0, ADD_DAILY_LIMIT - usage.add) }
    }) }] };
  }

  if (name === 'add_memory') {
    if (usage.add >= ADD_DAILY_LIMIT) {
      return { content: [{ type: 'text', text: JSON.stringify({ deferred: true, reason: 'Daily add_memory budget (' + ADD_DAILY_LIMIT + ') reached for today. Try again tomorrow.' }) }] };
    }
    const sector = SECTORS.includes(args.sector) ? args.sector : 'random';
    const r = await callMem0('/v3/memories/add/', { messages: [{ role: 'user', content: args.text }], user_id: DEFAULT_USER_ID, metadata: { sector: sector } });
    usage.add += 1;
    return { content: [{ type: 'text', text: JSON.stringify(r.json) }] };
  }

  if (name === 'search_memories') {
    if (usage.search >= SEARCH_DAILY_LIMIT) {
      return { content: [{ type: 'text', text: JSON.stringify({ deferred: true, reason: 'Daily search_memories budget (' + SEARCH_DAILY_LIMIT + ') reached for today. Answer without a memory search, or try again tomorrow.', usage_left: 0 }) }] };
    }
    const r = await callMem0('/v3/memories/search/', { query: args.query, filters: sectorFilters(args.sector) });
    usage.search += 1;
    return { content: [{ type: 'text', text: JSON.stringify(r.json) }] };
  }

  if (name === 'consolidate_memories') {
    const sector = SECTORS.includes(args.sector) ? args.sector : 'random';
    const items = await listSectorMemories(sector);
    if (items.length < 5) {
      return { content: [{ type: 'text', text: JSON.stringify({ skipped: true, count: items.length }) }] };
    }
    const combinedText = items.map(m => '- ' + (m.memory || '')).join('\n');
    const addResult = await callMem0('/v3/memories/add/', { messages: [{ role: 'user', content: 'Consolidate these facts, keeping only the distinct still-relevant ones:\n' + combinedText }], user_id: DEFAULT_USER_ID, metadata: { sector: sector, consolidated: true } });
    usage.add += 1;
    let deleted = 0;
    for (const m of items) {
      if (!m.id) continue;
      await callMem0Raw('DELETE', '/v1/memories/' + m.id + '/', null);
      deleted += 1;
    }
    return { content: [{ type: 'text', text: JSON.stringify({ before_count: items.length, deleted, add_status: addResult.json && addResult.json.status }) }] };
  }

  return { content: [{ type: 'text', text: 'Unknown tool: ' + name }], isError: true };
}

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(data);
}

// --- Shared-secret hardening ---
// Checked as a request header (X-Proxy-Key), since that's what Claude's custom
// connector UI actually supports injecting on every request ('Request headers'
// field at setup) - a ?key= query param does NOT work, because Claude's own
// server probe (used to detect the auth type) does not reliably carry query
// strings through, so it sees a 401 and mis-detects the server as OAuth-only.
// A query param is still accepted too, for direct/manual calls.
function isAuthorized(req) {
  if (!PROXY_SECRET) return true;
  const headerKey = req.headers['x-proxy-key'];
  if (headerKey === PROXY_SECRET) return true;
  const { query } = parseUrl(req.url, true);
  return query.key === PROXY_SECRET;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (req.method === 'POST' && req.url.split('?')[0] === '/mcp') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized: missing or invalid key' } });
      return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body); }
      catch (e) { sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
      const { id, method, params } = msg;
      if (method === 'initialize') {
        sendJson(res, 200, { jsonrpc: '2.0', id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mem0-simple-proxy', version: '7.0.0' } } });
        return;
      }
      if (method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      if (method === 'tools/list') { sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
      if (method === 'tools/call') {
        try {
          const result = await handleToolCall(params.name, params.arguments || {});
          sendJson(res, 200, { jsonrpc: '2.0', id, result });
        } catch (e) {
          sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32000, message: e.message } });
        }
        return;
      }
      sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('mem0 simple proxy listening on port ' + PORT);
});
