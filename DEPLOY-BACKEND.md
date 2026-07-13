# Scenique Backend Deploy Guide

This guide covers production deployment for the backend used by Muralizer concept generation, concept image storage, and measurement-request storage.

## 1) Required Environment Variables

Set these on the deployed backend service:

- `PORT`
- `MURALIZER_API_KEY` (preferred; `STABILITY_API_KEY` also supported for compatibility)
- `MURALIZER_GENERATE_URL` (optional, defaults to `https://muralizer.onrender.com/generate`)
- `SCENIQUE_DATA_DIR` (required on Render when using Persistent Disk)

Example:

```bash
PORT=8787
MURALIZER_API_KEY=your_real_api_key_here
MURALIZER_GENERATE_URL=https://muralizer.onrender.com/generate
SCENIQUE_DATA_DIR=/var/data/scenique
```

## 1.1) Render Persistent Disk Setup

For Render Web Service deployment:

- Add a Persistent Disk (for example 1 GB).
- Mount path: `/var/data`.
- Set env var `SCENIQUE_DATA_DIR=/var/data/scenique`.

This ensures concept images and JSON indexes survive redeploys and restarts.

## 2) Start Command

Use the existing script:

```bash
npm run start:backend
```

This runs `scripts/scenique-server.js`.

## 3) Frontend API Base Configuration

Set a global override before `scenique-backend.js` loads:

```html
<script>
  window.SCENIQUE_API_BASE_URL = "https://your-backend-host.example.com";
</script>
<script src="scenique-backend.js"></script>
```

All frontend storage and generate calls route through this backend base.

## 4) Production Smoke Tests

Run these after deploy (replace host):

```bash
curl -s https://your-backend-host.example.com/api/health
```

```bash
curl -s -X POST https://your-backend-host.example.com/api/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"test mural","negative_prompt":"","aspect_ratio":"1:1","seed":1,"model":"test"}'
```

```bash
curl -s -X POST https://your-backend-host.example.com/api/concept-images \
  -H "Content-Type: application/json" \
  -d '{"id":"smoke_concept_1","createdAt":"2026-01-01T00:00:00.000Z","context":{"client":"Smoke Client","project":"Smoke Project"},"concept":"c1","imageBase64":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6X+XcAAAAASUVORK5CYII="}'
```

```bash
curl -s https://your-backend-host.example.com/api/concept-images
```

## 5) Security Notes

- The browser no longer sends generation API keys.
- Keep `MURALIZER_API_KEY` server-side only.
- Restrict CORS to your production origins once final domains are known.
- Rotate keys periodically.
