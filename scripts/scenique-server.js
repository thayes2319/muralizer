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
const conceptShareIndexPath = path.join(dataDir, 'concept-shares.json');
const port = Number(process.env.PORT || 8787);
const host = String(process.env.HOST || '0.0.0.0').trim() || '0.0.0.0';
const serviceRevision = String(process.env.RENDER_GIT_COMMIT || process.env.SOURCE_VERSION || 'local').trim() || 'local';
const generateUpstream = String(process.env.MURALIZER_GENERATE_URL || '').trim();
const upstreamApiKey = String(
  process.env.MURALIZER_API_KEY
  || process.env.STABILITY_API_KEY
  || ''
).trim();
const openAiApiKey = String(
  process.env.MURALIZER_OPENAI_API_KEY
  || process.env.OPENAI_API_KEY
  || ''
).trim();
const openAiVisionModel = String(process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini').trim();

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
  await writeJson(filePath, capRecordsPerOwner(current));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Scenique-Backend-Revision': serviceRevision,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key'
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, contentType, body) {
  res.writeHead(statusCode, {
    'Content-Type': `${contentType}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'X-Scenique-Backend-Revision': serviceRevision,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key'
  });
  res.end(body);
}

function sendNoContent(res, statusCode) {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'X-Scenique-Backend-Revision': serviceRevision,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
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

const MAX_RECORDS_PER_OWNER = 500;

// Keeps each owner's most-recent MAX_RECORDS_PER_OWNER records, independent
// of every other owner -- `items` must already be newest-first (unshift'd).
// Replaces a flat `slice(0, 500)` shared across ALL owners combined, which
// meant one owner's heavy activity (including repeated automated test runs
// against this same production index) could silently evict a completely
// different owner's real saved concepts with no warning. Confirmed this had
// already started happening: the concept-image index's oldest surviving
// record had drifted to just ~3.5 days old under that flat cap.
function capRecordsPerOwner(items) {
  const seenCounts = new Map();
  const kept = [];
  for (const record of items) {
    const key = normalizeOwnerId(record && record.ownerId) || '__unowned__';
    const count = seenCounts.get(key) || 0;
    if (count < MAX_RECORDS_PER_OWNER) {
      kept.push(record);
      seenCounts.set(key, count + 1);
    }
  }
  return kept;
}

function normalizeMatchValue(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeConceptMatchValue(value) {
  return normalizeMatchValue(value).replace(/\s+/g, '');
}

function toPositiveTimestamp(value) {
  const stamp = Number(new Date(value || 0));
  return Number.isFinite(stamp) && stamp > 0 ? stamp : 0;
}

function getRecordRank(record) {
  const isSavedRecord = !!(record && record.savedConcept)
    || String(record && record.id || '').toLowerCase().startsWith('cpc_saved_');
  return isSavedRecord ? 2 : 1;
}

function resolveRecordImageFilePath(record) {
  const storedPath = String(record && record.imagePath || '').trim();
  if (storedPath) {
    const resolved = resolveWithin(dataDir, storedPath);
    if (resolved) return resolved;
  }

  const imageUrl = String(record && record.imageUrl || '').trim();
  if (imageUrl.startsWith('/storage/')) {
    const storageRelative = imageUrl.replace('/storage/', '/');
    const resolved = resolveWithin(dataDir, storageRelative);
    if (resolved) return resolved;
  }

  return null;
}

function pickTemplateConceptRecords(items, templateClient, templateProject, conceptNames) {
  const desiredConcepts = new Set(
    (Array.isArray(conceptNames) ? conceptNames : ['c1', 'c2', 'c3'])
      .map((name) => normalizeConceptMatchValue(name))
      .filter(Boolean)
  );

  const clientNorm = normalizeMatchValue(templateClient || 'EClient 3');
  const projectNorm = normalizeMatchValue(templateProject || 'Project 1');
  const bestByConcept = new Map();

  items.forEach((item) => {
    const context = item && item.context && typeof item.context === 'object' ? item.context : {};
    const itemClient = normalizeMatchValue(context.client || item.client);
    const itemProject = normalizeMatchValue(context.project || item.project);
    const itemConcept = normalizeConceptMatchValue(item && item.concept);
    if (!itemClient || !itemProject || !itemConcept) return;
    if (itemClient !== clientNorm || itemProject !== projectNorm) return;
    if (desiredConcepts.size && !desiredConcepts.has(itemConcept)) return;

    const imageFilePath = resolveRecordImageFilePath(item);
    if (!imageFilePath) return;

    const nextScore = {
      rank: getRecordRank(item),
      createdAt: toPositiveTimestamp(item && item.createdAt)
    };

    const prev = bestByConcept.get(itemConcept);
    if (!prev) {
      bestByConcept.set(itemConcept, { item, imageFilePath, score: nextScore });
      return;
    }

    const shouldReplace = nextScore.rank > prev.score.rank
      || (nextScore.rank === prev.score.rank && nextScore.createdAt > prev.score.createdAt);

    if (shouldReplace) {
      bestByConcept.set(itemConcept, { item, imageFilePath, score: nextScore });
    }
  });

  return Array.from(bestByConcept.entries()).map(([concept, payload]) => ({ concept, ...payload }));
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

function parseImageDataUrl(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!match) return null;

  return {
    mimeType: match[1].toLowerCase(),
    buffer: Buffer.from(match[2].replace(/\s/g, ''), 'base64')
  };
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

// Backend half of the cross-device "Share with client" link
// (openConceptPresentationFromData / window.SceniqueBackend.createConceptShare
// + loadConceptShare in scenique-backend.js) -- that frontend contract
// already existed and was already being called; this was the missing
// server side. img is resolved and stored HERE (from the concept-images
// index, by conceptId) rather than at load time, so loadConceptShare can
// return everything openConceptPresentationFromData needs -- {img, title,
// sub, scene} -- in one request instead of a second round-trip.
async function handleCreateConceptShare(req, res) {
  const body = await readBody(req);
  const conceptId = String(body.conceptId || '').trim();
  if (!conceptId) {
    sendJson(res, 400, { ok: false, error: 'conceptId is required.' });
    return;
  }

  const concepts = await readJson(conceptIndexPath, []);
  const concept = Array.isArray(concepts) ? concepts.find((item) => item && item.id === conceptId) : null;
  if (!concept || !concept.imageUrl) {
    sendJson(res, 404, { ok: false, error: 'That concept could not be found.' });
    return;
  }

  const token = crypto.randomBytes(9).toString('base64url'); // 12 chars, matches the frontend's [A-Za-z0-9_-]{6,32} check
  const record = {
    token,
    conceptId,
    ownerId: normalizeOwnerId(body.ownerId),
    title: body.title !== undefined ? body.title : null,
    sub: body.sub !== undefined ? body.sub : null,
    scene: body.scene !== undefined ? body.scene : null,
    img: concept.imageUrl,
    createdAt: new Date().toISOString()
  };

  await appendJsonItem(conceptShareIndexPath, record);
  sendJson(res, 201, record);
}

async function handleGetConceptShare(req, res, token) {
  const shares = await readJson(conceptShareIndexPath, []);
  const record = Array.isArray(shares) ? shares.find((item) => item && item.token === token) : null;
  if (!record) {
    sendJson(res, 404, { ok: false, error: 'This share link is invalid or has expired.' });
    return;
  }
  sendJson(res, 200, record);
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

async function handleDeleteConceptImages(req, res, url) {
  const items = await readJson(conceptIndexPath, []);
  if (!Array.isArray(items) || !items.length) {
    sendJson(res, 200, { ok: true, deleted: 0, remaining: 0 });
    return;
  }

  const ownerId = normalizeOwnerId(url.searchParams.get('ownerId'));
  const client = normalizeMatchValue(url.searchParams.get('client'));
  const project = normalizeMatchValue(url.searchParams.get('project'));
  const conceptParams = url.searchParams.getAll('concept');
  const conceptValues = conceptParams
    .flatMap((value) => String(value || '').split(','))
    .map((value) => normalizeMatchValue(value).replace(/\s+/g, ''))
    .filter(Boolean);
  const conceptSet = new Set(conceptValues);

  const removed = [];
  const kept = [];

  items.forEach((item) => {
    const itemOwnerId = normalizeOwnerId(item && item.ownerId);
    const itemClient = normalizeMatchValue(item && item.context && item.context.client);
    const itemProject = normalizeMatchValue(item && item.context && item.context.project);
    const itemConcept = normalizeMatchValue(item && item.concept).replace(/\s+/g, '');

    if (ownerId && itemOwnerId !== ownerId) {
      kept.push(item);
      return;
    }

    if (client && itemClient !== client) {
      kept.push(item);
      return;
    }

    if (project && itemProject !== project) {
      kept.push(item);
      return;
    }

    if (conceptSet.size && !conceptSet.has(itemConcept)) {
      kept.push(item);
      return;
    }

    removed.push(item);
  });

  if (!removed.length) {
    sendJson(res, 200, { ok: true, deleted: 0, remaining: kept.length });
    return;
  }

  await Promise.all(removed.map(async (item) => {
    const storedPath = String(item && item.imagePath || '').trim();
    if (!storedPath) return;
    const filePath = resolveWithin(dataDir, storedPath);
    if (!filePath) return;
    try {
      await fs.unlink(filePath);
    } catch {
      // Ignore file deletion failures for missing/locked files.
    }
  }));

  await writeJson(conceptIndexPath, kept);
  sendJson(res, 200, { ok: true, deleted: removed.length, remaining: kept.length });
}

async function handleRenameConceptImages(req, res) {
  const body = await readBody(req);
  const items = await readJson(conceptIndexPath, []);
  if (!Array.isArray(items) || !items.length) {
    sendJson(res, 200, { ok: true, renamed: 0, remaining: 0 });
    return;
  }

  const filters = body && typeof body === 'object' ? (body.filters || {}) : {};
  const updates = body && typeof body === 'object' ? (body.updates || {}) : {};

  const ownerId = normalizeOwnerId(filters.ownerId);
  const client = normalizeMatchValue(filters.client);
  const project = normalizeMatchValue(filters.project);
  const conceptValues = (Array.isArray(filters.concepts) ? filters.concepts : [filters.concept])
    .flatMap((value) => String(value || '').split(','))
    .map((value) => normalizeConceptMatchValue(value))
    .filter(Boolean);
  const conceptSet = new Set(conceptValues);

  const nextClient = String(updates.client || '').trim();
  const nextProject = String(updates.project || '').trim();
  const nextConcept = String(updates.concept || '').trim();

  if (!nextClient && !nextProject && !nextConcept) {
    sendJson(res, 400, { ok: false, error: 'No rename updates supplied' });
    return;
  }

  let renamed = 0;
  const nextItems = items.map((item) => {
    const itemOwnerId = normalizeOwnerId(item && item.ownerId);
    const itemContext = item && item.context && typeof item.context === 'object' ? item.context : {};
    const currentClient = String(itemContext.client || item.client || '').trim();
    const currentProject = String(itemContext.project || item.project || '').trim();
    const currentConcept = String(item.concept || itemContext.concept || '').trim();

    const itemClient = normalizeMatchValue(currentClient);
    const itemProject = normalizeMatchValue(currentProject);
    const itemConcept = normalizeConceptMatchValue(currentConcept);

    if (ownerId && itemOwnerId !== ownerId) return item;
    if (client && itemClient !== client) return item;
    if (project && itemProject !== project) return item;
    if (conceptSet.size && !conceptSet.has(itemConcept)) return item;

    const updatedClient = nextClient || currentClient;
    const updatedProject = nextProject || currentProject;
    const updatedConcept = nextConcept || currentConcept;

    const updatedContext = {
      ...itemContext,
      client: updatedClient,
      project: updatedProject
    };

    const nextItem = {
      ...item,
      context: updatedContext,
      concept: updatedConcept
    };

    // Keep compatibility for older records that also stored client/project at top level.
    if (Object.prototype.hasOwnProperty.call(item, 'client') || nextClient) {
      nextItem.client = updatedClient;
    }

    if (Object.prototype.hasOwnProperty.call(item, 'project') || nextProject) {
      nextItem.project = updatedProject;
    }

    if (typeof item.imageKey === 'string' && item.imageKey.includes('::')) {
      const parts = item.imageKey.split('::');
      const variant = parts[2] || '';
      if (variant) {
        const keyClient = normalizeMatchValue(updatedClient);
        const keyProject = normalizeMatchValue(updatedProject);
        const keyConcept = normalizeConceptMatchValue(updatedConcept) || 'c1';
        nextItem.imageKey = `${keyClient}|${keyProject}::${keyConcept}::${variant}`;
      }
    }

    renamed += 1;
    return nextItem;
  });

  if (!renamed) {
    sendJson(res, 200, { ok: true, renamed: 0, remaining: items.length });
    return;
  }

  await writeJson(conceptIndexPath, nextItems);
  sendJson(res, 200, { ok: true, renamed, remaining: nextItems.length });
}

async function handleSeedDefaultConcepts(req, res) {
  const body = await readBody(req);
  const ownerId = normalizeOwnerId(body && body.ownerId);
  if (!ownerId) {
    sendJson(res, 400, { ok: false, error: 'ownerId is required' });
    return;
  }

  const templateClient = String(body && body.templateClient || 'EClient 3').trim() || 'EClient 3';
  const templateProject = String(body && body.templateProject || 'Project 1').trim() || 'Project 1';
  const conceptNames = Array.isArray(body && body.concepts) && body.concepts.length
    ? body.concepts
    : ['c1', 'c2', 'c3'];

  const items = await readJson(conceptIndexPath, []);
  if (!Array.isArray(items)) {
    sendJson(res, 500, { ok: false, error: 'Concept index is invalid' });
    return;
  }

  const ownerClientNorm = normalizeMatchValue(templateClient);
  const ownerProjectNorm = normalizeMatchValue(templateProject);
  const ownerAlreadyHasTemplate = items.some((item) => {
    const itemOwnerId = normalizeOwnerId(item && item.ownerId);
    const context = item && item.context && typeof item.context === 'object' ? item.context : {};
    const itemClient = normalizeMatchValue(context.client || item.client);
    const itemProject = normalizeMatchValue(context.project || item.project);
    return itemOwnerId === ownerId && itemClient === ownerClientNorm && itemProject === ownerProjectNorm;
  });

  if (ownerAlreadyHasTemplate) {
    sendJson(res, 200, { ok: true, seeded: 0, skipped: true, reason: 'owner-template-exists' });
    return;
  }

  const templateRecords = pickTemplateConceptRecords(items, templateClient, templateProject, conceptNames);
  if (!templateRecords.length) {
    sendJson(res, 404, { ok: false, seeded: 0, error: 'No template EClient 3 concept images found' });
    return;
  }

  const createdAt = new Date().toISOString();
  const nextItems = [...items];
  let seeded = 0;

  for (let i = 0; i < templateRecords.length; i += 1) {
    const template = templateRecords[i];
    const conceptName = String(template && template.concept || '').trim() || `c${i + 1}`;
    const sourceFilePath = template && template.imageFilePath;
    if (!sourceFilePath) continue;

    const nextId = sanitizeName(`cpc_seed_${Date.now()}_${conceptName}_${crypto.randomUUID().slice(0, 6)}`);
    const imageFileName = `${nextId}.png`;
    const targetImagePath = path.join(conceptDir, imageFileName);
    await fs.copyFile(sourceFilePath, targetImagePath);

    let imageSizeBytes = null;
    try {
      const stat = await fs.stat(targetImagePath);
      imageSizeBytes = Number.isFinite(stat.size) ? stat.size : null;
    } catch {
      imageSizeBytes = null;
    }

    const normalizedConcept = normalizeConceptMatchValue(conceptName) || conceptName;
    const nextRecord = {
      id: nextId,
      createdAt,
      ownerId,
      context: {
        client: templateClient,
        project: templateProject
      },
      concept: normalizedConcept,
      imageKey: `${normalizeMatchValue(templateClient)}|${normalizeMatchValue(templateProject)}::${normalizedConcept}::saved`,
      saveAction: 'seed',
      savedConcept: true,
      seedTemplate: true,
      imageUrl: `/storage/concept-images/${imageFileName}`,
      imagePath: path.relative(dataDir, targetImagePath),
      imageSizeBytes
    };

    nextItems.unshift(nextRecord);
    seeded += 1;
  }

  if (!seeded) {
    sendJson(res, 404, { ok: false, seeded: 0, error: 'Template copy failed (no source files)' });
    return;
  }

  await writeJson(conceptIndexPath, capRecordsPerOwner(nextItems));
  sendJson(res, 200, {
    ok: true,
    seeded,
    skipped: false,
    ownerId,
    templateClient,
    templateProject
  });
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

async function handleReferenceGenerateProxy(req, res) {
  const body = await readBody(req);
  const reference = parseImageDataUrl(body.reference_image);
  if (!reference || !reference.buffer.length) {
    sendJson(res, 400, { ok: false, error: 'A PNG, JPEG, or WebP reference image is required.' });
    return;
  }
  if (reference.buffer.length > 10 * 1024 * 1024) {
    sendJson(res, 413, { ok: false, error: 'Reference image exceeds the 10 MB provider limit.' });
    return;
  }
  if (!upstreamApiKey) {
    sendJson(res, 503, { ok: false, error: 'Image generation is not configured.' });
    return;
  }

  const prompt = String(body.prompt || '').trim();
  if (!prompt) {
    sendJson(res, 400, { ok: false, error: 'A mural brief is required.' });
    return;
  }

  const influence = Number(body.reference_influence);
  // Same slider/value the UI exposes as "Source influence" -- reused for
  // whichever Stability parameter applies to this mode (see below). Ceiling
  // raised 0.65 -> 1.0 by request (2026-08-14): capping control_strength
  // well below max meant Pure Inspiration could never be told to adhere
  // strongly to the reference's actual structure/composition, no matter how
  // high the user pushed the slider -- a second, independent cause of the
  // same content-drift symptom the assessment-instruction fix above
  // addressed (that fix stopped the prompt text from fighting fidelity;
  // this stops the structural-adherence ceiling from capping it too). 0.3-
  // 0.65 was the original tested-safe band; 0.65-1.0 is untested territory
  // for Inspired Blend's fidelity parameter specifically (the wall-mockup
  // fidelity control saw style bleed at 0.8 in its own context -- see
  // handleWallMockupProxy), but carries no equivalent known risk for
  // control_strength, whose whole purpose is stronger structural adherence.
  const influenceValue = Number.isFinite(influence)
    ? Math.max(0.3, Math.min(1, influence))
    : 0.45;

  // Pure Inspiration vs Inspired Blend need genuinely different Stability
  // endpoints, not just different prompt text -- see the branch below.
  const isBlend = body.reference_mode === 'blend';

  const form = new FormData();
  const imageExtension = reference.mimeType === 'image/jpeg' ? 'jpg' : reference.mimeType.split('/')[1];
  form.append('image', new Blob([reference.buffer], { type: reference.mimeType }), `inspiration.${imageExtension}`);
  const muralOnly = 'Create a flat, front-facing original mural artwork only. The full canvas must be the mural design itself, with no interior scene or installed-mural mockup.';
  // Applies to both modes -- reinforces the same never-photorealistic goal
  // regardless of which endpoint below actually enforces it. Leads with a
  // short, unconditional directive rather than opening with it: prompt
  // order matters, and this used to run AFTER `prompt` (the assessed
  // description, which for a photographic/reflective/mechanical subject
  // reads with its own photographic register) -- putting the style
  // directive last made it read as a modifier competing with an
  // already-established photographic frame instead of the frame itself.
  // "surrounding cohesivity and agreement" is deliberately explicit:
  // real-device testing showed a subject can pick up isolated painterly
  // phrasing (from the assessed description) while everything around it
  // -- and the subject's own reflective/metallic surfaces -- stayed
  // photographic, i.e. the instruction was being satisfied locally/
  // token-wise without actually governing the whole piece.
  //
  // The gleams/highlights sentence (2026-08-14) used to live in the assessed
  // Mural Description instead, phrased per-photo by the vision-assessment
  // step -- moved here because that made it a content/image mismatch (a
  // per-photo description declaring "gleams treated subtly" as an already-
  // true fact about pixels that are still a photograph) and made correct
  // phrasing dependent on that less reliable step getting the wording right
  // every single time. Stated once, here, as the imperative it actually is,
  // it applies uniformly and correctly regardless of what the assessed
  // description says. Distinct from the capture-artifacts sentence after it:
  // this is about the subject's own genuine material properties (it's
  // actually reflective metal/glass), not incidental real-world lighting
  // from however the reference photo happened to be taken.
  const paintedStyle = 'Repaint this scene in painterly form, with surrounding cohesivity and agreement -- every element, the subject included, rendered with the same consistent hand-painted brushwork, artistic texture, and hand-rendered color blending throughout, never as a photograph or photorealistic image, no matter how photographic the reference image itself looks. Abstract and simplify all natural elements such as foliage, water, and light into visible brushstrokes, not photographic detail. Where the subject itself is genuinely reflective or metallic -- painted metal, glass, chrome trim -- treat its gleams and reflections as such but subtly, not with realism. Ignore any glare, reflections, or lighting artifacts from the reference photo being captured under real light; those are not part of the artwork.';
  const exclusions = 'Never depict furniture, chairs, tables, sofas, beds, lamps, windows, doors, rooms, walls, floors, ceilings, architecture, people, text, logos, frames, or borders.';
  form.append('prompt', `${paintedStyle}\n\n${prompt}\n\n${muralOnly} ${exclusions}`);
  form.append('output_format', 'png');

  // Pure Inspiration: prompt text is just a description of the reference
  // photo itself (assessedDescription), so locking the output's
  // composition/layout to that same photo via /control/structure is a
  // strict improvement -- sandboxed side-by-side against both a
  // photographic and an already-painterly reference across the full
  // influence range, consistently painterly either way, no regression.
  //
  // Inspired Blend: prompt text instead comes from the user's own Creative
  // Direction selections (Category/Feel/Elements/etc.), which describe
  // whatever content the user picked -- with no guaranteed relationship to
  // what's structurally in the reference photo. /control/structure forces
  // the output to conform to the reference's edges/layout regardless, which
  // fights a prompt describing different content and broke this mode in
  // real device testing. Kept on the original /control/style endpoint,
  // which transfers color/texture-level "visual character" rather than
  // rigid structural conformance, so it can actually blend divergent
  // content with the reference instead of fighting it.
  const endpoint = isBlend
    ? 'https://api.stability.ai/v2beta/stable-image/control/style'
    : 'https://api.stability.ai/v2beta/stable-image/control/structure';
  form.append(isBlend ? 'fidelity' : 'control_strength', String(influenceValue));

  const negativePrompt = String(body.negative_prompt || '').trim();
  if (negativePrompt) form.append('negative_prompt', negativePrompt);
  const aspectRatio = String(body.aspect_ratio || '').trim();
  if (aspectRatio) form.append('aspect_ratio', aspectRatio);
  if (body.seed !== undefined && body.seed !== null && body.seed !== '') {
    form.append('seed', String(body.seed));
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${upstreamApiKey}`,
      'Accept': 'image/*',
      'Stability-Client-ID': 'scenique-muralizer'
    },
    body: form
  });

  if (response.ok) {
    const buffer = Buffer.from(await response.arrayBuffer());
    sendJson(res, 200, { ok: true, success: true, image: buffer.toString('base64') });
    return;
  }

  let errorPayload = null;
  try {
    errorPayload = await response.json();
  } catch {
    errorPayload = { raw: await response.text().catch(() => '') };
  }
  sendJson(res, response.status || 500, {
    ok: false,
    error: 'Reference reimagination failed',
    details: errorPayload
  });
}

// "See It In A Room" (generic) -- feeds the actual displayed mural image
// into the same Stability image-conditioned endpoint handleReferenceGenerateProxy
// above uses, but flips its instruction: that one explicitly forbids rooms,
// walls, and furniture (it's generating a flat mural artwork); this one asks
// for exactly that -- a photorealistic generic interior with the mural
// installed on a wall.
const WALL_MOCKUP_PROMPT =
  "A professional real-estate interior photograph of a bright, tastefully furnished, completely generic and unbranded room, " +
  "with one large feature wall showing this exact mural pattern applied edge-to-edge as an installed wall mural, " +
  "preserving the mural's exact colors, motifs, and composition precisely and faithfully -- do not reinterpret, restyle, or redesign the mural itself. " +
  "If the mural depicts animals, birds, people, or other figurative subjects, those figures are the mural's dominant visual content and must remain " +
  "clearly visible, faithfully rendered, and unaltered -- never omitted, simplified away, or replaced with only the surrounding foliage, pattern, or background elements. " +
  "The mural pattern appears ONLY on that one wall. Every other surface -- furniture, upholstery, textiles, rugs, floors, ceiling, other walls -- " +
  "is plain, solid-colored, and unpatterned, in neutral modern interior tones, completely uninfluenced by the mural's colors or motifs. " +
  "If the mural includes an undulating berm of earth, providing a natural planted base from which taller growth emerges, that berm must remain " +
  "clearly visible and not cropped or omitted -- it stays a flat painted element of the wall mural itself, never rendered as literal 3D landscaping, soil, or floor extending into the room. " +
  "Natural daylight, soft realistic shadows and perspective, believable modern interior, wide-angle real-estate photography style. " +
  "No real people occupying the room, no visible logos or text, no identifiable real location.";

const WALL_MOCKUP_NEGATIVE_PROMPT =
  "no text, no writing, no letters, no watermark, no logo, no signature, no UI elements, " +
  "no borders, no frames, no collage, no real people occupying the room, no distorted architecture, no warped walls, no blurry areas, " +
  "no reinterpreting the mural design, no altering the mural's colors or motifs, no different artwork, " +
  "no omitting the mural's animal, bird, or figurative subjects, no replacing mural figures with only plain pattern or foliage, " +
  "no patterned furniture, no patterned upholstery, no patterned textiles, no patterned rugs, no patterned floors, " +
  "no matching furniture colors, no mural pattern outside the feature wall, " +
  "no literal earth or soil extending into the room, no 3D landscaping, no berm breaking the wall plane";

async function handleWallMockupProxy(req, res) {
  const body = await readBody(req);
  const reference = parseImageDataUrl(body.mural_image);
  if (!reference || !reference.buffer.length) {
    sendJson(res, 400, { ok: false, error: 'A generated mural image is required.' });
    return;
  }
  if (reference.buffer.length > 10 * 1024 * 1024) {
    sendJson(res, 413, { ok: false, error: 'Mural image exceeds the 10 MB provider limit.' });
    return;
  }
  if (!upstreamApiKey) {
    sendJson(res, 503, { ok: false, error: 'Image generation is not configured.' });
    return;
  }

  // History: 0.4 -> 0.8 (real testing: bled the mural's style onto
  // furniture/floors/textiles too -- fidelity has no spatial/regional
  // control, so it pushes the reference's influence over the WHOLE scene,
  // not just the wall) -> 0.5 (confirmed good via real testing) -> 0.45,
  // landed here by direct request after 0.5 tested well. The explicit "only
  // on that one wall" prompt/negative-prompt language above is doing the
  // spatial-confinement work; fidelity itself just balances overall
  // adherence vs. creative freedom. User-adjustable via the frontend's
  // fidelity slider. Ceiling raised 0.65 -> 0.90 by request (2026-08-14) --
  // 0.3-0.65 is the tested-safe band above; 0.65-0.90 is NOT re-verified
  // against the bleed problem 0.8 previously caused and carries the same
  // known risk, just now reachable if the user wants to push past it.
  const requestedFidelity = Number(body.fidelity);
  const fidelity = Number.isFinite(requestedFidelity)
    ? Math.max(0.3, Math.min(0.90, requestedFidelity))
    : 0.45;

  const form = new FormData();
  const imageExtension = reference.mimeType === 'image/jpeg' ? 'jpg' : reference.mimeType.split('/')[1];
  form.append('image', new Blob([reference.buffer], { type: reference.mimeType }), `mural.${imageExtension}`);
  form.append('prompt', WALL_MOCKUP_PROMPT);
  form.append('negative_prompt', WALL_MOCKUP_NEGATIVE_PROMPT);
  form.append('output_format', 'png');
  form.append('fidelity', String(fidelity));
  form.append('aspect_ratio', '3:2');
  if (body.seed !== undefined && body.seed !== null && body.seed !== '') {
    form.append('seed', String(body.seed));
  }

  const response = await fetch('https://api.stability.ai/v2beta/stable-image/control/style', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${upstreamApiKey}`,
      'Accept': 'image/*',
      'Stability-Client-ID': 'scenique-muralizer'
    },
    body: form
  });

  if (response.ok) {
    const buffer = Buffer.from(await response.arrayBuffer());
    sendJson(res, 200, { ok: true, success: true, image: buffer.toString('base64') });
    return;
  }

  let errorPayload = null;
  try {
    errorPayload = await response.json();
  } catch {
    errorPayload = { raw: await response.text().catch(() => '') };
  }
  sendJson(res, response.status || 500, {
    ok: false,
    error: 'Wall mockup generation failed',
    details: errorPayload
  });
}

// Deterministic safety net for the Mural Description handleReferenceAssessment
// returns. The assessment instructions above explicitly ban this exact
// vocabulary, and real-device testing has now shown the model uses it
// anyway on a meaningful fraction of runs regardless -- confirmed twice on
// the same test subject (a reflective/metallic/glossy car): first with zero
// painterly language at all, then again, after strengthening and
// reordering the instructions, with genuinely distributed painterly
// language throughout EXCEPT for two exact banned terms ("polished",
// "metallic sheen") still slipping through verbatim. Better wording reduces
// how often this happens but doesn't reach zero -- an LLM instruction is
// still just a request, not a guarantee. This catches what gets through in
// code instead of hoping the next wording tweak is the one that finally
// works. Word-boundary, case-insensitive; replacements stay grammatical
// without reintroducing photographic-finish language of their own.
const PAINTERLY_TERM_REPLACEMENTS = [
  [/\bphotorealistic\b/gi, 'painterly'],
  [/\bphotorealism\b/gi, 'painterly style'],
  [/\bphotographic\b/gi, 'painted'],
  [/\bmetallic sheen\b/gi, 'painted metallic tones'],
  [/\bglossy\b/gi, 'richly pigmented'],
  [/\breflective\b/gi, 'richly toned'],
  [/\bpolished\b/gi, 'smoothly painted'],
  [/\bchrome\b/gi, 'painted silver-toned'],
  [/\bsleek\b/gi, 'elegant'],
  [/\bmirror-like\b/gi, 'richly toned']
];

function sanitizePainterlyDescription(text) {
  let sanitized = text;
  for (const [pattern, replacement] of PAINTERLY_TERM_REPLACEMENTS) {
    if (pattern.test(sanitized)) {
      console.warn(`[painterly-sanitize] replaced ${pattern} in an assessed description`);
    }
    pattern.lastIndex = 0; // .test() with a /g pattern advances lastIndex -- reset before .replace() reuses it
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

async function handleReferenceAssessment(req, res) {
  const body = await readBody(req);
  const reference = parseImageDataUrl(body.reference_image);
  if (!reference || !reference.buffer.length) {
    sendJson(res, 400, { ok: false, error: 'A PNG, JPEG, or WebP reference image is required.' });
    return;
  }
  if (reference.buffer.length > 10 * 1024 * 1024) {
    sendJson(res, 413, { ok: false, error: 'Reference image exceeds the 10 MB provider limit.' });
    return;
  }
  if (!openAiApiKey) {
    sendJson(res, 503, { ok: false, error: 'Reference assessment is not configured.' });
    return;
  }

  const currentDescription = String(body.current_description || '').trim();
  const schema = {
    name: 'reference_mural_assessment',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        assessment: {
          type: 'object',
          additionalProperties: false,
          properties: {
            genre: { type: 'string' },
            palette: { type: 'string' },
            visual_treatment: { type: 'string' },
            botanical_character: { type: 'string' },
            lower_edge: { type: 'string' },
            composition: { type: 'string' },
            source_context_to_exclude: { type: 'string' }
          },
          required: ['genre', 'palette', 'visual_treatment', 'botanical_character', 'lower_edge', 'composition', 'source_context_to_exclude']
        },
        mural_description: { type: 'string' }
      },
      required: ['assessment', 'mural_description']
    }
  };
  const instructions = [
    // Leads everything, deliberately -- prompt order matters, and this used
    // to run 5th, after "report visual evidence"/"classify genre" language
    // that a strongly photographic/reflective/mechanical subject (a car)
    // could already read as license to describe literally, before ever
    // reaching the painterly requirement. Stated first, nothing downstream
    // gets to establish a competing photographic frame first. "cohesive...
    // throughout" is deliberate too: real-device testing showed a subject
    // picking up an isolated painterly phrase while its own reflective/
    // metallic surfaces, and everything around it, stayed photographic --
    // i.e. satisfied token-wise without actually governing the whole piece.
    // Revised again (2026-08-14): the previous wording ("must read as... a
    // painterly artwork... from the first sentence to the last") pushed the
    // model to open every description with something like "This mural
    // presents a hand-painted interpretation of..." -- and fixing only that
    // opening sentence turned out to be half a fix: the SAME declarative
    // pattern ("...is rendered with visible brushstrokes...", "...treated as
    // such but subtly...") ran through the rest of the paragraph too, every
    // time rendering technique got mentioned. Root cause is architectural,
    // not a wording tic in any one sentence: this description's job and
    // paintedStyle's job (below, in handleReferenceGenerateProxy) had been
    // blurring into each other. Settled division now -- Mural Description
    // describes WHAT is being sent (content: subject, colors, position,
    // setting, composition -- all genuinely true of the reference photo,
    // fine to state as fact); paintedStyle alone describes WHAT WE WANT (the
    // repaint transformation, an imperative -- "Repaint this scene..." --
    // applied to what's actually there, including the subject's own gleams/
    // reflections, stated once and applied uniformly instead of re-derived
    // per photo by this less reliable vision-assessment step). Content and
    // style claims must never share a sentence again: that's what let a
    // description assert a painterly quality about pixels that are
    // demonstrably a photograph, a direct mismatch against the actual
    // reference image this text is sent alongside.
    'Write the Mural Description as a plain, factual account of the subject, its identifying colors/features, its position, and its setting -- content only. Never describe HOW anything should be rendered (brushwork, painterly texture, "hand-rendered," how highlights or reflections are handled) anywhere in the description, not just its opening sentence -- rendering technique is decided once, separately, and applied uniformly at generation time, not re-derived per photo here. Still report evidence in plain terms, without photographic, reflective, glossy, polished, chrome, or metallic-finish words, no matter how photographic, reflective, or mechanically precise the subject in the reference photo actually is.',
    'Depict the same subject, its identifying colors and features, and the same setting shown in the reference photo -- never a substitute subject or an invented setting. Where "original" is asked for elsewhere, it means original artistic execution (hand-painted, not photographic), never different content.',
    'Assess the supplied inspiration image and write a concise, production-ready Mural Description.',
    'Report visual evidence only. Do not identify artists, locations, rooms, furniture, walls, frames, or installed-mural context as design content. When the subject is a recognizable make/model (a car, a specific object), name it plainly -- that specificity is what keeps the subject identifiable, not a violation of "visual evidence only."',
    'The reference is often a snapshot of an already-installed wall covering, so it frequently carries capture artifacts that are not part of the design: glare, reflections, lens flare, specular highlights, or lighting hotspots from the surface being photographed under real light. Note any such artifacts you observe in source_context_to_exclude (for example "glare across the upper-right area" or "reflective sheen along the lower edge") so they can be explicitly excluded -- these are never design content and must never be described as part of the Mural Description itself. Distinguish these capture artifacts from a deliberate painted color gradient or ombre fade, which IS design content and belongs in the Mural Description, not in source_context_to_exclude: a design gradient transitions smoothly across a broad area and follows the artwork\'s own color logic and composition, while a capture artifact is a localized, sharp-edged, often overexposed or blown-out highlight that is inconsistent with the surrounding painted palette and looks camera- or light-source-dependent rather than intentionally placed. When genuinely uncertain which one you are seeing, prefer treating it as design content rather than excluding it.',
    // Used to also require "at least one explicit painterly-texture phrase
    // ... describing the subject itself" -- dropped, not because subject
    // texture doesn't matter (real testing showed a subject can stay
    // photographic if nothing addresses it specifically), but because
    // requiring it HERE was requiring a rendering-technique claim inside a
    // description that's supposed to be content-only. paintedStyle now
    // covers the subject explicitly instead -- reliably, every time, in the
    // correct imperative voice, rather than depending on this per-photo
    // vision call to phrase it correctly.
    'Classify the image\'s genre and visual treatment from visual evidence, using the selected Muralizer category and sub-scene as scope guidance when supplied. Report what the evidence shows in plain content terms, without photographic, reflective, glossy, polished, chrome, or metallic-finish words.',
    'When the image visibly shows a planted, undulating lower botanical base from which taller growth emerges, write the Mural Description as four distinct paragraphs in this order: (1) an opening paragraph describing the evidenced visual treatment, background, and arrangement; (2) this berm paragraph: "The lower edge is importantly defined by an undulating berm of earth, providing a natural planted base from which the taller flowering branches emerge." Adapt only plant-type words when the evidence requires it; treat the berm as painted earth and planted forms, never as a literal floor or room surface; (3) a paragraph describing the evidenced blossoms, branches, leaves, birds, or other motifs and their balanced mural composition; (4) a closing paragraph requiring canopy and botanical forms, when present, to terminate naturally well before the top edge and preserve open breathing room above. Otherwise do not invent a berm, canopy, botanicals, or open-sky requirement; use a shorter evidence-led paragraph structure.',
    'Return an assessment with concise evidence and a 2-4 paragraph Mural Description. The description must remain editable by the user.',
    currentDescription ? `The user\'s current description is: ${currentDescription}` : 'There is no current user description.'
  ].join('\n');
  const imageDataUrl = `data:${reference.mimeType};base64,${reference.buffer.toString('base64')}`;
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openAiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: openAiVisionModel,
      temperature: 0.2,
      response_format: { type: 'json_schema', json_schema: schema },
      messages: [
        { role: 'system', content: 'You are a precise mural-art direction assessor. Follow the requested JSON schema exactly.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: instructions },
            { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    const details = await response.json().catch(() => null);
    sendJson(res, response.status || 502, { ok: false, error: 'Reference assessment failed', details });
    return;
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  let result = null;
  try {
    result = JSON.parse(String(content || ''));
  } catch {
    sendJson(res, 502, { ok: false, error: 'Reference assessment returned an invalid result.' });
    return;
  }
  if (!result || typeof result.mural_description !== 'string' || !result.mural_description.trim()) {
    sendJson(res, 502, { ok: false, error: 'Reference assessment did not produce a mural description.' });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    assessment: result.assessment,
    mural_description: sanitizePainterlyDescription(result.mural_description.trim())
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
      revision: serviceRevision,
      referenceGeneration: true,
      referenceAssessment: Boolean(openAiApiKey),
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

  if (req.method === 'GET' && url.pathname.startsWith('/api/concept-shares/')) {
    const token = decodeURIComponent(url.pathname.slice('/api/concept-shares/'.length));
    await handleGetConceptShare(req, res, token);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/concept-shares') {
    await handleCreateConceptShare(req, res);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/concept-images') {
    await handleConceptImage(req, res);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/concept-images/rename') {
    await handleRenameConceptImages(req, res);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/concept-images/seed-defaults') {
    await handleSeedDefaultConcepts(req, res);
    return true;
  }

  if (req.method === 'DELETE' && url.pathname === '/api/concept-images') {
    await handleDeleteConceptImages(req, res, url);
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

  if (req.method === 'POST' && url.pathname === '/api/generate-from-reference') {
    await handleReferenceGenerateProxy(req, res);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/generate-wall-mockup') {
    await handleWallMockupProxy(req, res);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/assess-reference') {
    await handleReferenceAssessment(req, res);
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
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*'
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
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
  } catch {
    const fallback = path.join(publicDir, 'index.html');
    try {
      const body = await fs.readFile(fallback);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
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
