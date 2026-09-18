const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 8000;
const MEM0_API_KEY = process.env.MEM0_API_KEY || '';
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID || '';

const SECTORS = ['work', 'studies', 'random'];

function callMem0(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.mem0.ai',
      path,
      method: 'POST',
      headers: {
        'Authorization': 'Token ' + MEM0_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(chunks || '{}') });
        } catch (e) {
          resolve({ status: res.statusCode, json: { raw: chunks } });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const TOOLS = [
  {
    name: 'add_memory',
    description: 'Store a new memory for the user, tagged with a sector.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The memory text to store.' },
        sector: { type: 'string', enum: SECTORS, description: 'Which sector this memory belongs to.' }
      },
      required: ['text', 'sector']
    }
  },
  {
    name: 'search_memories',
    description: 'Search stored memories for the user, optionally scoped to one sector.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        sector: { type: 'string', enum: SECTORS.concat(['all']), description: 'Limit the search to one sector, or all.' }
      },
      required: ['query']
    }
  },
  {
    name: 'debug_search',
    description: 'DEBUG: raw search with arbitrary filters JSON string.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        filters_json: { type: 'string', description: 'A JSON string for the filters object.' }
      },
      required: ['query', 'filters_json']
    }
  }
];

async function handleToolCall(name, args) {
  if (name === 'add_memory') {
    const sector = SECTORS.includes(args.sector) ? args.sector : 'random';
    const r = await callMem0('/v3/memories/add/', {
      messages: [{ role: 'user', content: args.text }],
      user_id: DEFAULT_USER_ID,
      agent_id: sector
    });
    return { content: [{ type: 'text', text: JSON.stringify(r.json) }] };
  }
  if (name === 'search_memories') {
    const filters = (args.sector && args.sector !== 'all' && SECTORS.includes(args.sector))
      ? { user_id: DEFAULT_USER_ID, agent_id: args.sector }
      : { user_id: DEFAULT_USER_ID };
    const r = await callMem0('/v3/memories/search/', { query: args.query, filters });
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
  }
  if (name === 'debug_search') {
    let filters;
    try { filters = JSON.parse(args.filters_json); } catch (e) { return { content: [{ type: 'text', text: 'bad json: ' + e.message }] }; }
    const r = await callMem0('/v3/memories/search/', { query: args.query, filters });
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
  }
  return { content: [{ type: 'text', text: 'Unknown tool: ' + name }], isError: true };
}

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(data);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method === 'POST' && req.url === '/mcp') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch (e) {
        sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }

      const { id, method, params } = msg;

      if (method === 'initialize') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'mem0-simple-proxy', version: '1.3.0-debug' }
          }
        });
        return;
      }

      if (method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }

      if (method === 'tools/list') {
        sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: TOOLS } });
        return;
      }

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
