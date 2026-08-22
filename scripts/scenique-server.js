const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const configuredDataDir = String(process.env.SCENIQUE_DATA_DIR || '').trim();
const fsNative = require('node:fs');
const readline = require('node:readline');
const dataDir = configuredDataDir
  ? path.resolve(configuredDataDir)
  : path.join(rootDir, 'data', 'scenique');
const conceptDir = path.join(dataDir, 'concept-images');
const conceptShareIndexPath = path.join(dataDir, 'concept-shares.json');
const requestDir = path.join(dataDir, 'measurement-requests');
const conceptIndexPath = path.join(dataDir, 'concept-images.json');
const requestIndexPath = path.join(dataDir, 'measurement-requests.json');
const port = Number(process.env.PORT || 8787);
const host = String(process.env.HOST || '0.0.0.0').trim() || '0.0.0.0';
const serviceRevision = String(process.env.RENDER_GIT_COMMIT || process.env.SOURCE_VERSION || 'local').trim() || 'local';
const generateUpstream = String(process.env.MURALIZER_GENERATE_URL || '').trim();
async function compactLegacyIndexImages(filePath) {
  const temporaryPath = `${filePath}.${process.pid}.compact`;
  let output = null;
  let removedCount = 0;

  try {
    await fs.access(filePath);
    const input = fsNative.createReadStream(filePath, { encoding: 'utf8' });
    output = fsNative.createWriteStream(temporaryPath, { encoding: 'utf8' });
    const streamError = new Promise((_, reject) => output.once('error', reject));
    const lines = readline.createInterface({ input, crlfDelay: Infinity });

    for await (const line of lines) {
      if (/^\s*"(?:dataUrl|imageDataUrl|imageBase64)"\s*:\s*"/.test(line)) {
        removedCount += 1;
        continue;
      }
      if (!output.write(`${line}\n`)) {
        await Promise.race([
          new Promise((resolve) => output.once('drain', resolve)),
          streamError
        ]);
      }
    }

    await Promise.race([
      new Promise((resolve) => output.end(resolve)),
      streamError
    ]);
    output = null;

    if (removedCount) {
      await fs.rename(temporaryPath, filePath);
      console.log(`Compacted ${removedCount} embedded image field(s) from ${path.basename(filePath)}.`);
    } else {
      await fs.unlink(temporaryPath);
    }
  } catch (error) {
    output?.destroy();
    await fs.unlink(temporaryPath).catch(() => {});
    if (error?.code !== 'ENOENT') {
      console.warn(`Unable to compact ${path.basename(filePath)}:`, error.message);
    }
  }
}

function sanitizeSceneForIndex(scene) {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return scene;
  const reference = scene.reference;
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return scene;

  const { dataUrl, imageDataUrl, imageBase64, ...referenceMetadata } = reference;
  return {
    ...scene,
    reference: referenceMetadata
  };
}

async function persistSceneReference(id, scene) {
  const sanitizedScene = sanitizeSceneForIndex(scene);
  const source = scene?.reference;
  const parsedReference = parseImageDataUrl(source?.dataUrl || source?.imageDataUrl || '');
  if (!parsedReference || !sanitizedScene?.reference) return sanitizedScene;

  const extension = parsedReference.mimeType === 'image/jpeg'
    ? 'jpg'
    : parsedReference.mimeType.split('/')[1];
  const fileName = `${id}.reference.${extension}`;
  const filePath = path.join(conceptDir, fileName);
  await fs.writeFile(filePath, parsedReference.buffer);

  return {
    ...sanitizedScene,
    reference: {
      ...sanitizedScene.reference,
      assetUrl: `/storage/concept-images/${fileName}`,
      assetPath: path.relative(dataDir, filePath),
      assetSizeBytes: parsedReference.buffer.length
    }
  };
}

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

function getConceptPosition(record) {
  const explicitPosition = Number(record && record.position);
  if (Number.isInteger(explicitPosition) && explicitPosition > 0) return explicitPosition;
  const match = String(record && record.concept || '').match(/c\s*(\d+)/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function buildCanonicalConceptRecords(items, ownerId) {
  const canonicalByIdentity = new Map();
  (Array.isArray(items) ? items : []).forEach((item) => {
    if (ownerId && normalizeOwnerId(item && item.ownerId) !== ownerId) return;
    if (getRecordRank(item) !== 2 || !item || !item.imageUrl) return;

    const context = item.context && typeof item.context === 'object' ? item.context : {};
    const client = String(context.client || item.client || '').trim();
    const project = String(context.project || item.project || '').trim();
    const concept = String(item.concept || '').trim();
    if (!client || !project || !concept) return;

    // New records have a permanent ID. Legacy records are imported once by
    // their old slot name so they remain visible, but all new writes use the
    // permanent ID and never depend on this fallback.
    const conceptId = String(item.conceptId || item.id || '').trim();
    if (!conceptId) return;
    const legacyIdentity = `${normalizeOwnerId(item.ownerId) || '__unowned__'}|${normalizeMatchValue(client)}|${normalizeMatchValue(project)}|${normalizeConceptMatchValue(concept)}`;
    const identity = item.conceptId ? `id:${conceptId}` : `legacy:${legacyIdentity}`;
    const existing = canonicalByIdentity.get(identity);
    if (!existing || toPositiveTimestamp(item.createdAt) > toPositiveTimestamp(existing.createdAt)) {
      canonicalByIdentity.set(identity, {
        ...item,
        conceptId,
        position: getConceptPosition(item),
        context: { ...context, client, project }
      });
    }
  });

  return Array.from(canonicalByIdentity.values())
    .sort((a, b) => getConceptPosition(a) - getConceptPosition(b) || toPositiveTimestamp(a.createdAt) - toPositiveTimestamp(b.createdAt));
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
    if (total > 14 * 1024 * 1024) {
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
  const isCanonicalSave = body.savedConcept === true && body.canonical === true;
  const conceptId = isCanonicalSave
    ? sanitizeName(body.conceptId || `concept_${crypto.randomUUID()}`)
    : '';
  const id = sanitizeName(body.id || conceptId || `cpc_img_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`);
  const createdAt = body.createdAt || new Date().toISOString();
  const ownerId = normalizeOwnerId(body.ownerId);
  const imageBuffer = dataUrlToBuffer(body.imageBase64, body.imageDataUrl);
  const imageFileName = `${id}.png`;
  const imagePath = path.join(conceptDir, imageFileName);
  const imageUrl = `/storage/concept-images/${imageFileName}`;

  if (imageBuffer) {
    await fs.writeFile(imagePath, imageBuffer);
  }

  const scene = body.savedConcept
    ? await persistSceneReference(id, body.scene)
    : sanitizeSceneForIndex(body.scene);

  const record = {
    ...body,
    id,
    createdAt,
    ownerId,
    conceptId: conceptId || undefined,
    position: isCanonicalSave ? getConceptPosition(body) : undefined,
    canonical: isCanonicalSave || undefined,
    imageUrl,
    imagePath: path.relative(dataDir, imagePath),
    imageSizeBytes: imageBuffer ? imageBuffer.length : null,
    scene,
    imageBase64: undefined,
    imageDataUrl: undefined
  };

  const existingItems = await readJson(conceptIndexPath, []);
  if (isCanonicalSave && Array.isArray(existingItems)) {
    const replaced = existingItems.filter((item) => String(item && item.conceptId || '') !== conceptId);
    await writeJson(conceptIndexPath, capRecordsPerOwner([record, ...replaced]));
  } else {
    await appendJsonItem(conceptIndexPath, record);
  }
  sendJson(res, 201, record);
}

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

  const record = {
    token: crypto.randomBytes(9).toString('base64url'),
    conceptId,
    ownerId: normalizeOwnerId(body.ownerId),
    title: body.title !== undefined ? body.title : null,
    sub: body.sub !== undefined ? body.sub : null,
    scene: body.scene !== undefined ? sanitizeSceneForIndex(body.scene) : null,
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
  const conceptIdSet = new Set(url.searchParams.getAll('conceptId').map((value) => String(value || '').trim()).filter(Boolean));

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

    if (conceptIdSet.size && !conceptIdSet.has(String(item && item.conceptId || item && item.id || ''))) {
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
    // Index can reference template files no longer on disk (post data-loss);
    // skip those instead of letting ENOENT 500 the whole seed for every new owner.
    try {
      await fs.copyFile(sourceFilePath, targetImagePath);
    } catch (copyError) {
      console.warn(`[seed-defaults] template copy failed for ${conceptName}:`, copyError.message);
      continue;
    }

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
  // Keep the request contract aligned with the 30-100% Source Influence
  // slider. Structure control uses this value to preserve the reference
  // composition; silently clipping the upper UI range makes the control lie.
  const controlStrength = Number.isFinite(influence)
    ? Math.max(0.3, Math.min(1, influence))
    : 0.45;
  const form = new FormData();
  const imageExtension = reference.mimeType === 'image/jpeg' ? 'jpg' : reference.mimeType.split('/')[1];
  form.append('image', new Blob([reference.buffer], { type: reference.mimeType }), `inspiration.${imageExtension}`);
  const muralOnly = 'Create a flat, front-facing original mural artwork only. The full canvas must be the mural design itself, with no interior scene or installed-mural mockup.';
  // Switched from Stability's /control/style to /control/structure. Style
  // control explicitly extracts and reapplies the reference image's own
  // stylistic qualities (color, texture, photographic-ness) -- for a
  // photographic reference (e.g. a foliage/water inspiration photo, not
  // just an installed-wallcovering snapshot), that pulled the output toward
  // photorealism no matter how strongly worded this instruction was, even
  // at low influence. Structure control only constrains composition/layout
  // from the reference, leaving style entirely up to this text -- sandboxed
  // side-by-side against both a photographic and an already-painterly
  // reference, across the full influence range, with consistently painterly
  // results either way.
  const paintedStyle = 'STYLE REQUIREMENT -- takes priority over every realism cue in the reference or mural brief: render a flat, expressive, clearly hand-painted decorative mural, with unmistakable broad brush marks, layered opaque color, simplified painted shapes, and deliberate hand-drawn linework. The result must read immediately as a two-dimensional artwork on a wall, never as a photograph, product render, or cinematic still. Treat the reference image strictly as a guide to subject placement and composition, never as a rendering exemplar. Reinterpret words such as realistic, reflective, metallic, polished, detailed, or precise as loose painted suggestions only: no physically accurate materials, no glossy reflections, no precise surface texture, no camera-like lighting, and no illusionistic depth. Convert depicted light, atmosphere, natural forms, built forms, and material surfaces into visible painterly marks and expressive blocks of color. Ignore any glare, reflections, or lighting artifacts from the reference photo being captured under real light; those are not part of the artwork.';
  const exclusions = 'Never depict furniture, chairs, tables, sofas, beds, lamps, windows, doors, rooms, walls, floors, ceilings, architecture, text, logos, frames, or borders.';
  form.append('prompt', `${prompt}\n\n${muralOnly} ${paintedStyle} ${exclusions}`);
  form.append('output_format', 'png');
  form.append('control_strength', String(controlStrength));
  const negativePrompt = String(body.negative_prompt || '').trim();
  if (negativePrompt) form.append('negative_prompt', negativePrompt);
  const aspectRatio = String(body.aspect_ratio || '').trim();
  if (aspectRatio) form.append('aspect_ratio', aspectRatio);
  if (body.seed !== undefined && body.seed !== null && body.seed !== '') {
    form.append('seed', String(body.seed));
  }

  const response = await fetch('https://api.stability.ai/v2beta/stable-image/control/structure', {
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
  // 0.3-0.65 is the tested-safe band above; 0.65-0.90 is not re-verified
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
  const assessmentMode = body.assessment_mode === 'source-reading' ? 'source-reading' : 'art-direction';
  const sourceReadingLabels = ['Foreground:', 'Subject:', 'Background:', 'Composition:'];
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
  const artDirectionInstructions = [
    'Assess the supplied inspiration image and write a concise, production-ready Mural Description.',
    'Work forward from the intended painted mural, not backward from a photographic caption. Use the source only to identify enduring subject, large palette relationships, silhouette, gesture, and compositional masses that can survive in the new artwork. Deliberately discard any source detail whose only expression would be literal rendering: branding, exact product components, wheel or surface detail, reflections, gloss, camera perspective, atmospheric depth, capture lighting, or staged setting. Do not identify artists, brands, locations, rooms, furniture, walls, frames, or installed-mural context as design content.',
    'The reference is often a snapshot of an already-installed wall covering, so it frequently carries capture artifacts that are not part of the design: glare, reflections, lens flare, specular highlights, or lighting hotspots from the surface being photographed under real light. Note any such artifacts you observe in source_context_to_exclude (for example "glare across the upper-right area" or "reflective sheen along the lower edge") so they can be explicitly excluded -- these are never design content and must never be described as part of the Mural Description itself. Distinguish these capture artifacts from a deliberate painted color gradient or ombre fade, which IS design content and belongs in the Mural Description, not in source_context_to_exclude: a design gradient transitions smoothly across a broad area and follows the artwork\'s own color logic and composition, while a capture artifact is a localized, sharp-edged, often overexposed or blown-out highlight that is inconsistent with the surrounding painted palette and looks camera- or light-source-dependent rather than intentionally placed. When genuinely uncertain which one you are seeing, prefer treating it as design content rather than excluding it.',
    'The Mural Description is sent directly to the image generator, so write exactly three short paragraphs of concrete affirmative art direction for a new, original painted image, never a literal image caption or a descriptive assessment. This is a subject-neutral quality contract: adapt its nouns to the visible source, but preserve its degree of specificity. Before writing, identify the source subject\'s defining pose or orientation, its key silhouette features, and its dominant color relationships; all three must appear in the Mural Description as painted decisions. Paragraph 1 must begin "A hand-painted image of" and name the depicted subject, its defining pose or orientation, a restrained painted palette grounded in the source, and a deliberately composed environmental scenic setting. That setting must surround or sit behind the subject as a readable backdrop, with at least two layers of painted context appropriate to the source, such as terrain, water, sky, vegetation, distant structural silhouettes, or abstract landscape forms; never use a blank studio field, empty asphalt or floor plane, or product-display staging as the setting. It must say how broad layered brushwork and painted marks describe the subject\'s meaningful silhouette or features. Paragraph 2 must begin "Using the same brushwork technique" and direct the subject and scenic setting as connected parts of one painted composition, with the setting resolving into layered simplified painted forms that share the subject\'s visual language. Paragraph 3 must begin "Use" and direct selective painted highlights and gestural linework to only suggest any real materials or technical qualities, while requiring a flat, expressive decorative-mural character; include concise exclusions for visible source branding, product marks, physical staging, or photographic lighting when they are present. Preserve the source image\'s meaningful subject, palette, visual treatment, and compositional relationships as inspiration, but describe the intended artwork rather than merely inventorying the source or asking to copy it. Never use product, performance, or camera language, including high-performance, sleek, luxury, premium, aerodynamic, aggressive, dynamic presence, polished finish, reflective surfaces, metallic surfaces, precise detail, precision engineering, technical sophistication, product shot, studio lighting, camera-like lighting, or photographic realism. Translate any photographic or product-design detail into painterly cues such as sculptural silhouette, selective painted highlights, gestural linework, layered brushwork, simplified painted forms, scenic painted background layers, and expressive blocks of color. Every paragraph must make a specific visual decision for the painted artwork.',
    'In the returned art direction, use "image" rather than "mural" whenever referring to the new artwork. Never use the word "mural" in the returned description.',
    'First classify the image genre and visual treatment from visual evidence. The reference photo may itself be an ordinary camera photograph -- for example a snapshot of an already-installed wall covering -- but the Mural Description you write must always describe a hand-painted or hand-illustrated artwork, never a photograph, regardless of how photographic the reference image itself looks. Use the selected Muralizer category and sub-scene as scope guidance when supplied, but let the image\'s depicted subject and rendering style -- not its status as a photo -- control the genre. For a modern graphic reference, use precise graphic-mural language appropriate to its forms, color blocks, linework, repeat, or geometry; do not force painterly, botanical, or open-sky language. For a painterly, scenic, Chinoiserie, or botanical reference, use the painterly language evidenced by the image\'s depicted style. Never describe or request photorealism, photographic lighting, camera effects, lens artifacts, or realistic depth of field in the Mural Description -- always describe painted, illustrated, or hand-rendered artistic qualities instead.',
    'When the image visibly shows a planted, undulating lower botanical base from which taller growth emerges, write the Mural Description as four distinct paragraphs in this order: (1) an opening paragraph describing the evidenced visual treatment, background, and arrangement; (2) this berm paragraph: "The lower edge is importantly defined by an undulating berm of earth, providing a natural planted base from which the taller flowering branches emerge." Adapt only plant-type words when the evidence requires it; treat the berm as painted earth and planted forms, never as a literal floor or room surface; (3) a paragraph describing the evidenced blossoms, branches, leaves, birds, or other motifs and their balanced mural composition; (4) a closing paragraph requiring canopy and botanical forms, when present, to terminate naturally well before the top edge and preserve open breathing room above. Otherwise use a shorter, evidence-led paragraph structure. Do not report absent botanicals, lower-edge features, or empty upper areas; simply describe the positive visual direction the new mural should have.',
    'Return an assessment with concise evidence and a 2-4 paragraph Mural Description. The description must remain editable by the user.',
    currentDescription ? `The user\'s current description is: ${currentDescription}` : 'There is no current user description.'
  ].join('\n');
  const sourceReadingInstructions = [
    'Inspect the supplied inspiration image and return a concise source reading for a separate painterly image-generation system.',
    'This is not art direction. The image-generation system already has its own overall painted outcome and rendering rules. Your role is only to identify source content that it may adapt, without adding style, medium, lighting, realism, scenic, or quality instructions of your own.',
    'Set mural_description to exactly four short labeled lines in this order: "Foreground:", "Subject:", "Background:", and "Composition:". Include every label even when the relevant area is absent; say "none visible" rather than inventing content. Foreground, subject, and background should identify only broad enduring forms and palette relationships. Composition should state only the most important spatial relationship, crop, balance, or directional gesture.',
    'The image-generation system places Subject in its first, authoritative outcome sentence. Therefore Subject must be a concise noun phrase beginning with "a", "an", or "the" that can follow "Give the subject,". A user-selected Category and Sub-Scene normally replace Background in that sentence, so Background is fallback-only source context: make it concise, source-evidenced, and never let it impose scenery over a user selection. Preserve specific subject attributes that make the image recognizable, such as color, pose, or interior. Do not include labels, complete sentences, instructions, or terminal punctuation in either value. Foreground and Composition remain as the two lower supporting lines, so do not repeat the subject or background there unless their relationship is essential to the composition.',
    'Curtail source detail aggressively. Keep only large silhouettes, broad color families, major foreground/background relationships, and composition. Exclude brand names, logos, lettering, exact product components, wheels, surface texture, reflections, gloss, camera angle, lens effects, photographic lighting, staged settings, material accuracy, and any adjective that turns the source into a product image. Do not use product, performance, or camera language.',
    'Use source_context_to_exclude only for capture artifacts such as glare, reflections, lens flare, specular highlights, or lighting hotspots. Do not treat those artifacts as image content.',
    'Return the existing JSON schema only.',
    currentDescription ? `The user\'s current description is: ${currentDescription}` : 'There is no current user description.'
  ].join('\n');
  const instructions = assessmentMode === 'source-reading' ? sourceReadingInstructions : artDirectionInstructions;
  const forbiddenMuralTerms = [
    ['sleek', /\bsleek\b/i],
    ['high-performance', /\bhigh-performance\b/i],
    ['luxury or premium', /\b(luxury|premium)\b/i],
    ['aerodynamic', /\baerodynamic\b/i],
    ['aggressive stance', /\baggressive stance\b/i],
    ['dynamic presence', /\bdynamic presence\b/i],
    ['prominent subject', /\bprominen(t|tly)\b/i],
    ['polished finish', /\bpolished finish\b/i],
    ['reflective or metallic surfaces', /\b(reflective|metallic) surfaces\b/i],
    ['precision engineering', /\b(precision engineering|technical sophistication|technical shapes)\b/i]
  ];
  const findForbiddenMuralTerms = (description) => forbiddenMuralTerms
    .filter(([, pattern]) => pattern.test(description))
    .map(([label]) => label);
  const imageDataUrl = `data:${reference.mimeType};base64,${reference.buffer.toString('base64')}`;
  let result = null;
  let repairInstruction = '';
  let priorCandidate = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const content = attempt === 0
      ? [
        { type: 'text', text: instructions },
        { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } }
      ]
      : [{ type: 'text', text: repairInstruction }];
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
            content
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
    let candidate = null;
    try {
      candidate = JSON.parse(String(payload?.choices?.[0]?.message?.content || ''));
    } catch {
      sendJson(res, 502, { ok: false, error: 'Reference assessment returned an invalid result.' });
      return;
    }
    if (!candidate || typeof candidate.mural_description !== 'string' || !candidate.mural_description.trim()) {
      sendJson(res, 502, { ok: false, error: 'Reference assessment did not produce a mural description.' });
      return;
    }

    const violations = findForbiddenMuralTerms(candidate.mural_description);
    const hasStructuredSourceReading = assessmentMode !== 'source-reading' || sourceReadingLabels.every((label) =>
      new RegExp(`^${label.replace(':', '\\:')}`, 'mi').test(candidate.mural_description)
    );
    if (!violations.length && hasStructuredSourceReading) {
      result = candidate;
      break;
    }
    priorCandidate = candidate;
    repairInstruction = assessmentMode === 'source-reading'
      ? `Rewrite this assessment JSON as a constrained source reading. mural_description must be exactly four short labeled lines in this order: Foreground:, Subject:, Background:, Composition:. Subject must be a concise noun phrase beginning with a, an, or the and usable after "Give the subject,". Background is fallback-only source context because a user-selected Category and Sub-Scene normally replace it; keep it concise and never use it as rendering direction. Neither field may include terminal punctuation, a complete sentence, or rendering directions. Foreground and Composition are the lower supporting lines. The description must identify only broad source forms, broad palette relationships, and the key spatial relationship. The literal terms ${violations.join(', ') || 'none'} must not appear anywhere in mural_description, including as a negation. Return the same JSON schema only. Prior JSON:\n${JSON.stringify(priorCandidate)}`
      : `Rewrite this assessment JSON as a concise, production-ready mural brief. The Mural Description must contain exactly three short paragraphs: an "A hand-painted mural of" opening that names only enduring subject, palette, silhouette, and simplified setting; a "Using the same brushwork technique" paragraph that joins those elements as one painted composition; and a "Use" paragraph that directs only painted marks, selective highlights, gestural linework, and flat decorative treatment. Remove literal product, photographic, or camera description. The literal terms ${violations.join(', ')} must not appear anywhere in the rewritten Mural Description, including as a negation. Return the same JSON schema only. Prior JSON:\n${JSON.stringify(priorCandidate)}`;
  }

  if (!result || typeof result.mural_description !== 'string' || !result.mural_description.trim()) {
    sendJson(res, 502, { ok: false, error: 'Reference assessment could not produce a mural description without product-render language.' });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    assessment: result.assessment,
    mural_description: result.mural_description.trim()
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
    const canonical = url.searchParams.get('canonical') === 'true';
    const filtered = canonical
      ? buildCanonicalConceptRecords(items, ownerId)
      : (ownerId ? items.filter((item) => normalizeOwnerId(item && item.ownerId) === ownerId) : items);
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
  await compactLegacyIndexImages(conceptIndexPath);
  await compactLegacyIndexImages(requestIndexPath);
  await compactLegacyIndexImages(conceptShareIndexPath);
  const server = http.createServer(requestHandler);
  server.listen(port, host, () => {
    console.log(`Scenique backend listening on http://${host}:${port}`);
  });
}

main().catch((err) => {
  console.error('Failed to start Scenique backend:', err);
  process.exitCode = 1;
});
