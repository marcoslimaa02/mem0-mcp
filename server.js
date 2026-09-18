const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 8000;
const MEM0_API_KEY = process.env.MEM0_API_KEY || '';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID || '';

const SECTORS = ['work', 'studies', 'random'];

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
  { name: 'add_memory', description: 'Store a new memory for the user, tagged with a sector.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, sector: { type: 'string', enum: SECTORS } }, required: ['text', 'sector'] } },
  { name: 'search_memories', description: 'Search stored memories for the user, optionally scoped to one sector.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, sector: { type: 'string', enum: SECTORS.concat(['all']) } }, required: ['query'] } },
  { name: 'consolidate_memories', description: 'Merge and compact all memories in a sector into fewer, denser memories, deleting the originals.',
    inputSchema: { type: 'object', properties: { sector: { type: 'string', enum: SECTORS } }, required: ['sector'] } },
  { name: 'debug_list_all', description: 'DEBUG: list all memories for the user, no sector filter, compact summary.',
    inputSchema: { type: 'object', properties: {} } }
];

async function handleToolCall(name, args) {
  if (name === 'add_memory') {
    const sector = SECTORS.includes(args.sector) ? args.sector : 'random';
    const r = await callMem0('/v3/memories/add/', { messages: [{ role: 'user', content: args.text }], user_id: DEFAULT_USER_ID, agent_id: sector });
    return { content: [{ type: 'text', text: JSON.stringify(r.json) }] };
  }
  if (name === 'search_memories') {
    const filters = (args.sector && args.sector !== 'all' && SECTORS.includes(args.sector))
      ? { user_id: DEFAULT_USER_ID, agent_id: args.sector }
      : { user_id: DEFAULT_USER_ID };
    const r = await callMem0('/v3/memories/search/', { query: args.query, filters });
    return { content: [{ type: 'text', text: JSON.stringify(r.json) }] };
  }
  if (name === 'consolidate_memories') {
    const sector = SECTORS.includes(args.sector) ? args.sector : 'random';
    const r = await callMem0('/v3/memories/?page=1&page_size=100', { filters: { user_id: DEFAULT_USER_ID, agent_id: sector } });
    const items = (r.json && (r.json.results || r.json.memories || r.json.data)) || [];
    if (items.length < 5) {
      return { content: [{ type: 'text', text: JSON.stringify({ skipped: true, count: items.length }) }] };
    }
    const combinedText = items.map(m => '- ' + (m.memory || m.text || '')).join('\n');
    const addResult = await callMem0('/v3/memories/add/', { messages: [{ role: 'user', content: 'Consolidate:\n' + combinedText }], user_id: DEFAULT_USER_ID, agent_id: sector });
    let deleted = 0;
    for (const m of items) {
      const id = m.id || m.memory_id;
      if (!id) continue;
      await callMem0Raw('DELETE', '/v1/memories/' + id + '/', null);
      deleted += 1;
    }
    return { content: [{ type: 'text', text: JSON.stringify({ before_count: items.length, deleted }) }] };
  }
  if (name === 'debug_list_all') {
    const r = await callMem0('/v3/memories/?page=1&page_size=50', { filters: { user_id: DEFAULT_USER_ID } });
    const items = (r.json && (r.json.results || r.json.memories || r.json.data)) || [];
    const summary = items.map(m => ({
      memory: m.memory ? String(m.memory).slice(0, 50) : null,
      agent_id: m.agent_id === undefined ? 'MISSING_KEY' : m.agent_id,
      keys: Object.keys(m)
    }));
    return { content: [{ type: 'text', text: JSON.stringify({ status: r.status, raw_top_keys: Object.keys(r.json || {}), count: items.length, summary: summary.slice(0, 5) }) }] };
  }
  return { content: [{ type: 'text', text: 'Unknown tool: ' + name }], isError: true };
}

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(data);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (req.method === 'POST' && req.url === '/mcp') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body); }
      catch (e) { sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
      const { id, method, params } = msg;
      if (method === 'initialize') {
        sendJson(res, 200, { jsonrpc: '2.0', id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mem0-simple-proxy', version: '2.1.0-debug' } } });
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
