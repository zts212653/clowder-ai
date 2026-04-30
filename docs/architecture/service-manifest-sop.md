---
feature_ids: [F179]
topics: [architecture, service-manifest, sop]
doc_kind: guide
created: 2026-04-23
---

# Service Manifest SOP

How to register a new external service dependency in the console.

## Steps

1. **Define manifest** in `packages/api/src/domains/services/service-registry.ts`:
   ```typescript
   {
     id: 'my-service',
     name: 'My Service 描述',
     type: 'python',           // 'python' | 'node' | 'binary'
     port: 9999,
     healthEndpoint: '/health',
     prerequisites: {
       runtime: 'python3.10+',
       venvPath: '~/.cat-cafe/my-venv',
       packages: ['fastapi', 'uvicorn'],
     },
     scripts: {
       start: 'scripts/my-service.sh',
     },
     enablesFeatures: ['my-feature'],
     configVars: ['MY_SERVICE_URL'],
   }
   ```

2. **Register env vars** in `packages/api/src/config/env-registry.ts`:
   - Add `MY_SERVICE_URL` with category, description, restartRequired
   - Add to the correct category group

3. **Add health display** in the relevant settings section:
   ```tsx
   <ServiceStatusPanel
     filterFeatures={['my-feature']}
     title="Service Status"
   />
   ```

4. **Write startup script** in `scripts/` if the service needs one

5. **Test**:
   - `GET /api/services` includes the new service
   - `GET /api/services/my-service/health` returns status
   - Frontend shows status dot in the correct section

## ServiceManifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| id | Yes | Unique kebab-case identifier |
| name | Yes | Human-readable name (Chinese) |
| type | Yes | Runtime type: python/node/binary |
| port | No | Port number (required for health checks) |
| healthEndpoint | No | Health check path (e.g. /health) |
| prerequisites | Yes | Runtime, venv, packages needed |
| scripts | Yes | Start/stop/install shell scripts |
| enablesFeatures | Yes | Feature flags this service enables |
| configVars | Yes | Related env var names |

## Health Status

| Status | Meaning | Display |
|--------|---------|---------|
| running | Health endpoint returned 200 | Green dot |
| stopped | ECONNREFUSED or timeout | Gray dot |
| error | Non-200 response | Red dot |
| unknown | No health endpoint configured | Gray dot |
