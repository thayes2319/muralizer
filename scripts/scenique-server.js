const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const configuredDataDir = String(process.env.SCENIQUE_DATA_DIR || '').trim();
const dataDir = configuredDataDir
  ? path.resolve(configuredDataDir)
  : path.join(rootDir, 'data', 'scenique');
const conceptDir = path.join(dataDir, 'concept-images');
const requestDir = path.join(dataDir, 'measurement-requests');
const conceptIndexPath = path.join(dataDir, 'concept-images.json');
const requestIndexPath = path.join(dataDir, 'measurement-requests.json');
const port = Number(process.env.PORT || 8787);
const host = String(process.env.HOST || '0.0.0.0').trim() || '0.0.0.0';
const generateUpstream = String(process.env.MURALIZER_GENERATE_URL || '').trim();
const upstreamApiKey = String(
  process.env.MURALIZER_API_KEY
  || process.env.STABILITY_API_KEY
  || ''
).trim();

async function ensureDirectories() {
  await fs.mkdir(conceptDir, { recursive: true });
  await fs.mkdir(requestDir, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function appendJsonItem(filePath, item) {
  const current = await readJson(filePath, []);
  current.unshift(item);
  await writeJson(filePath, current.slice(0, 500));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key'
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, contentType, body) {
  res.writeHead(statusCode, {
    'Content-Type': `${contentType}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key'
  });
  res.end(body);
}

function sendNoContent(res, statusCode) {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key'
  });
  res.end();
}

function sanitizeName(name) {
  return String(name || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'item';
}

function normalizeOwnerId(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function dataUrlToBuffer(imageBase64, imageDataUrl) {
  if (typeof imageBase64 === 'string' && imageBase64.trim()) {
    return Buffer.from(imageBase64, 'base64');
  }

  if (typeof imageDataUrl === 'string' && imageDataUrl.startsWith('data:')) {
    const commaIndex = imageDataUrl.indexOf(',');
    if (commaIndex >= 0) {
      return Buffer.from(imageDataUrl.slice(commaIndex + 1), 'base64');
    }
  }

  return null;
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html';
  if (ext === '.js') return 'application/javascript';
  if (ext === '.css') return 'text/css';
  if (ext === '.json') return 'application/json';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.ico') return 'image/x-icon';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.txt') return 'text/plain';
  return 'application/octet-stream';
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 25 * 1024 * 1024) {
      const err = new Error('Request body too large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

function resolveWithin(baseDir, requestPath) {
  const decoded = decodeURIComponent(requestPath.replace(/^\/+/, ''));
  const resolved = path.resolve(baseDir, decoded);
  if (!resolved.startsWith(baseDir)) return null;
  return resolved;
}

async function handleConceptImage(req, res) {
  const body = await readBody(req);
  const id = sanitizeName(body.id || `cpc_img_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`);
  const createdAt = body.createdAt || new Date().toISOString();
  const ownerId = normalizeOwnerId(body.ownerId);
  const imageBuffer = dataUrlToBuffer(body.imageBase64, body.imageDataUrl);
  const imageFileName = `${id}.png`;
  const imagePath = path.join(conceptDir, imageFileName);
  const imageUrl = `/storage/concept-images/${imageFileName}`;

  if (imageBuffer) {
    await fs.writeFile(imagePath, imageBuffer);
  }

  const record = {
    ...body,
    id,
    createdAt,
    ownerId,
    imageUrl,
    imagePath: path.relative(dataDir, imagePath),
    imageSizeBytes: imageBuffer ? imageBuffer.length : null,
    imageBase64: undefined,
    imageDataUrl: undefined
  };

  await appendJsonItem(conceptIndexPath, record);
  sendJson(res, 201, record);
}

async function handleMeasurementRequest(req, res) {
  const body = await readBody(req);
  const id = sanitizeName(body.requestId || `mr_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`);
  const ownerId = normalizeOwnerId(body.ownerId);
  const record = {
    ...body,
    ownerId,
    requestId: id,
    receivedAt: new Date().toISOString()
  };

  await appendJsonItem(requestIndexPath, record);
  sendJson(res, 201, record);
}

async function handleGenerateProxy(req, res) {
  const body = await readBody(req);
  const reqHost = String((req.headers && req.headers.host) || '').trim().toLowerCase();
  let useExternalUpstream = Boolean(generateUpstream);

  if (useExternalUpstream) {
    try {
      const upstreamUrl = new URL(generateUpstream);
      const upstreamHost = String(upstreamUrl.host || '').trim().toLowerCase();
      const upstreamPath = String(upstreamUrl.pathname || '').trim();
      // Avoid proxying back to this same service and triggering 405 loops.
      if (upstreamHost && reqHost && upstreamHost === reqHost && upstreamPath === '/generate') {
        useExternalUpstream = false;
      }
    } catch {
      useExternalUpstream = false;
    }
  }

  if (useExternalUpstream) {
    const response = await fetch(generateUpstream, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': upstreamApiKey
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { ok: false, raw: text };
    }

    sendJson(res, response.status, parsed);
    return;
  }

  const form = new FormData();
  const prompt = String(body.prompt || '').trim();
  const negativePrompt = String(body.negative_prompt || '').trim();
  const aspectRatio = String(body.aspect_ratio || '').trim();
  const model = String(body.model || 'sd3.5-large').trim() || 'sd3.5-large';

  form.append('prompt', prompt);
  form.append('model', model);
  form.append('output_format', 'png');
  if (negativePrompt) form.append('negative_prompt', negativePrompt);
  if (aspectRatio) form.append('aspect_ratio', aspectRatio);
  if (body.seed !== undefined && body.seed !== null && body.seed !== '') {
    form.append('seed', String(body.seed));
  }
  form.append('none', '');

  const response = await fetch('https://api.stability.ai/v2beta/stable-image/generate/sd3', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${upstreamApiKey}`,
      'Accept': 'image/*'
    },
    body: form
  });

  if (response.status === 200) {
    const buffer = Buffer.from(await response.arrayBuffer());
    sendJson(res, 200, {
      ok: true,
      success: true,
      image: buffer.toString('base64')
    });
    return;
  }

  let errorPayload = null;
  try {
    errorPayload = await response.json();
  } catch {
    const raw = await response.text().catch(() => '');
    errorPayload = { raw };
  }

  sendJson(res, response.status || 500, {
    ok: false,
    error: 'Generation failed',
    details: errorPayload
  });
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    sendNoContent(res, 204);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'scenique-backend',
      time: new Date().toISOString()
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/concept-images') {
    const items = await readJson(conceptIndexPath, []);
    const ownerId = normalizeOwnerId(url.searchParams.get('ownerId'));
    const filtered = ownerId
      ? items.filter((item) => normalizeOwnerId(item && item.ownerId) === ownerId)
      : items;
    sendJson(res, 200, filtered);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/measurement-requests') {
    const items = await readJson(requestIndexPath, []);
    sendJson(res, 200, items);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/concept-images') {
    await handleConceptImage(req, res);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/measurement-requests') {
    await handleMeasurementRequest(req, res);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/generate') {
    await handleGenerateProxy(req, res);
    return true;
  }

  return false;
}

async function serveStatic(req, res, url) {
  let relativePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const isStoragePath = relativePath.startsWith('/storage/');
  const baseDir = isStoragePath ? dataDir : publicDir;
  if (isStoragePath) {
    relativePath = relativePath.replace('/storage/', '/');
  }

  const filePath = resolveWithin(baseDir, relativePath);
  if (!filePath) {
    sendText(res, 403, 'text/plain', 'Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      const indexPath = path.join(filePath, 'index.html');
      const indexStat = await fs.stat(indexPath).catch(() => null);
      if (indexStat && indexStat.isFile()) {
        const body = await fs.readFile(indexPath);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        res.end(body);
        return;
      }
      sendText(res, 404, 'text/plain', 'Not found');
      return;
    }

    const body = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': getContentType(filePath),
      'Cache-Control': 'no-store'
    });
    res.end(body);
  } catch {
    const fallback = path.join(publicDir, 'index.html');
    try {
      const body = await fs.readFile(fallback);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(body);
    } catch {
      sendText(res, 404, 'text/plain', 'Not found');
    }
  }
}

async function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled) {
        sendJson(res, 404, { ok: false, error: 'Not found' });
      }
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, url);
      return;
    }

    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (err) {
    const statusCode = Number(err && err.statusCode) || 500;
    sendJson(res, statusCode, {
      ok: false,
      error: err && err.message ? err.message : 'Server error'
    });
  }
}

async function main() {
  if (!upstreamApiKey) {
    throw new Error('MURALIZER_API_KEY (or STABILITY_API_KEY) is required for /api/generate proxy calls.');
  }

  await ensureDirectories();
  const server = http.createServer(requestHandler);
  server.listen(port, host, () => {
    console.log(`Scenique backend listening on http://${host}:${port}`);
  });
}

main().catch((err) => {
  console.error('Failed to start Scenique backend:', err);
  process.exitCode = 1;
});
