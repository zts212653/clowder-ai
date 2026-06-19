/**
 * Connector Plugin Management API — F240 Phase B-2
 *
 * Provides install/uninstall/update/list endpoints for external IM connector plugins.
 * Plugins are uploaded as tar.gz archives and extracted to `.cat-cafe/plugins/<id>/`.
 *
 * Routes:
 *   GET    /api/connectors/plugins          — list installed plugins
 *   POST   /api/connectors/plugins/install  — install or update a plugin (multipart upload)
 *   DELETE /api/connectors/plugins/:id      — uninstall a plugin
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { unregisterConnectorDefinition } from '@cat-cafe/shared';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  type CapabilityWriteRouteError,
  requireCapabilityWriteOwner,
} from '../config/capabilities/capability-write-guards.js';
import { configEventBus, createChangeSetId } from '../config/config-event-bus.js';
import { isOriginAllowed, PRIVATE_NETWORK_ORIGIN, resolveFrontendCorsOrigins } from '../config/frontend-origin.js';
import { unregisterExternalConnectorMeta } from '../infrastructure/connectors/external-connector-registry.js';
import { loadBuiltinConnectors } from '../infrastructure/connectors/im-connector-loader.js';
import { parseConnectorManifest } from '../infrastructure/connectors/plugins/im-connector-manifest.js';
import {
  installPlugin,
  listInstalledPlugins,
  resolvePluginsDir,
  uninstallPlugin,
} from '../infrastructure/connectors/plugins/plugin-installer.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { resolveSessionUserId } from '../utils/request-identity.js';
import { invalidateManifestCache } from './connector-hub.js';

const PLUGIN_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

export async function writeUploadedPluginArchive(tmpPath: string, buffer: Buffer): Promise<void> {
  await writeFile(tmpPath, buffer, { mode: 0o600 });
}

function isOutsideBase(relativePath: string): boolean {
  return (
    relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
  );
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function trustedPluginWriteOrigins(): (string | RegExp)[] {
  return resolveFrontendCorsOrigins(process.env).filter((origin) => origin !== PRIVATE_NETWORK_ORIGIN);
}

function requirePluginWriteAccess(request: FastifyRequest): CapabilityWriteRouteError | null {
  const userId = resolveSessionUserId(request);
  if (!userId) {
    return { status: 401, error: 'Plugin writes require session authentication' };
  }

  const origin = firstHeaderValue(request.headers.origin);
  if (!origin || !isOriginAllowed(origin, trustedPluginWriteOrigins())) {
    return { status: 403, error: 'Connector plugin writes require same-origin Hub access' };
  }

  return requireCapabilityWriteOwner(userId, {
    requireConfiguredOwner: true,
    missingOwnerError: 'Connector plugin writes require DEFAULT_OWNER_USER_ID to be configured',
  });
}

function requirePluginListAccess(request: FastifyRequest): CapabilityWriteRouteError | null {
  const userId = resolveSessionUserId(request);
  if (!userId) {
    return { status: 401, error: 'Plugin listing requires session authentication' };
  }

  const origin = firstHeaderValue(request.headers.origin);
  if (origin && !isOriginAllowed(origin, trustedPluginWriteOrigins())) {
    return { status: 403, error: 'Connector plugin listing requires same-origin Hub access' };
  }

  return requireCapabilityWriteOwner(userId, {
    requireConfiguredOwner: true,
    missingOwnerError: 'Connector plugin listing requires DEFAULT_OWNER_USER_ID to be configured',
  });
}

function toPublicPluginMeta(plugins: ReturnType<typeof listInstalledPlugins>) {
  return plugins.map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    hasManifest: plugin.hasManifest,
    hasEntry: plugin.hasEntry,
  }));
}

export const connectorPluginRoutes: FastifyPluginAsync = async (app) => {
  await app.register(multipart, {
    limits: {
      fileSize: PLUGIN_ARCHIVE_MAX_BYTES,
      files: 1,
    },
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error.code === 'FST_REQ_FILE_TOO_LARGE' || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({
        error: 'Plugin archive too large',
        code: 'PAYLOAD_TOO_LARGE',
        maxBytes: PLUGIN_ARCHIVE_MAX_BYTES,
      });
    }
    return reply.send(error);
  });

  // ── GET /api/connectors/plugins — list installed plugins ──

  app.get('/api/connectors/plugins', async (req: FastifyRequest, reply: FastifyReply) => {
    const accessErr = requirePluginListAccess(req);
    if (accessErr) return reply.status(accessErr.status).send({ error: accessErr.error });

    const projectRoot = resolveActiveProjectRoot();
    const plugins = listInstalledPlugins(projectRoot);
    return reply.send({ plugins: toPublicPluginMeta(plugins) });
  });

  // ── GET /api/connectors/plugins/:id/icon — serve plugin icon file ──
  // External plugins can't place files in web public/; this route serves
  // icons directly from .cat-cafe/plugins/<id>/ so connector.yaml can use
  // relative paths (e.g. `icon.svg`) that get rewritten to this API URL.

  app.get(
    '/api/connectors/plugins/:id/icon',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.params;
      const projectRoot = resolveActiveProjectRoot();
      const pluginDir = join(resolvePluginsDir(projectRoot), id);

      if (!existsSync(pluginDir)) {
        return reply.status(404).send({ error: 'Plugin not found' });
      }

      const yamlPath = join(pluginDir, 'connector.yaml');
      if (!existsSync(yamlPath)) {
        return reply.status(404).send({ error: 'No manifest' });
      }

      let iconSrc: string | undefined;
      try {
        const manifest = parseConnectorManifest(yamlPath);
        iconSrc = 'src' in manifest.icon ? manifest.icon.src : undefined;
      } catch {
        return reply.status(500).send({ error: 'Bad manifest' });
      }

      if (!iconSrc) {
        return reply.status(404).send({ error: 'No icon configured' });
      }

      // Resolve within plugin dir — path traversal guard
      const resolvedPluginDir = resolve(pluginDir);
      const iconPath = resolve(resolvedPluginDir, iconSrc);
      const relativeIconPath = relative(resolvedPluginDir, iconPath);
      if (isOutsideBase(relativeIconPath) || !existsSync(iconPath)) {
        return reply.status(404).send({ error: 'Icon file not found' });
      }

      let realPluginDir: string;
      let realIconPath: string;
      try {
        realPluginDir = realpathSync(resolvedPluginDir);
        realIconPath = realpathSync(iconPath);
      } catch {
        return reply.status(404).send({ error: 'Icon file not found' });
      }

      if (isOutsideBase(relative(realPluginDir, realIconPath))) {
        return reply.status(404).send({ error: 'Icon file not found' });
      }

      const ext = iconPath.split('.').pop()?.toLowerCase();
      const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : 'application/octet-stream';

      return reply.type(mime).header('Cache-Control', 'public, max-age=3600').send(readFileSync(iconPath));
    },
  );

  // ── POST /api/connectors/plugins/install — install/update a plugin ──

  app.post('/api/connectors/plugins/install', async (req: FastifyRequest, reply: FastifyReply) => {
    const accessErr = requirePluginWriteAccess(req);
    if (accessErr) return reply.status(accessErr.status).send({ error: accessErr.error });

    const file = await req.file();
    if (!file) {
      return reply.status(400).send({ error: 'No file uploaded', code: 'NO_FILE' });
    }

    // Save uploaded file to temp location
    const tmpPath = join(tmpdir(), `cat-cafe-plugin-${randomUUID()}.tar.gz`);
    try {
      const buffer = await file.toBuffer();
      await writeUploadedPluginArchive(tmpPath, buffer);

      // Get built-in connector IDs to prevent conflicts
      const builtins = await loadBuiltinConnectors();
      const builtinIds = new Set(builtins.map((p) => p.id));

      const projectRoot = resolveActiveProjectRoot();
      const result = await installPlugin(projectRoot, tmpPath, builtinIds);

      if ('code' in result) {
        // Installation error
        return reply.status(400).send({ error: result.message, code: result.code });
      }

      // Invalidate manifest cache so status/config endpoints pick up new plugin
      invalidateManifestCache();

      // Fire config event to trigger gateway reload.
      // Use scope: 'file' so connector-reload-subscriber restarts unconditionally
      // (scope: 'key' with __plugin_* would be filtered out by CONNECTOR_GATEWAY_RELOAD_KEYS).
      configEventBus.emitChange({
        source: 'config-store',
        scope: 'file',
        changedKeys: [],
        changeSetId: createChangeSetId(),
        timestamp: Date.now(),
      });

      req.log.info({ id: result.id, action: result.action }, '[ConnectorPlugins] Plugin installed');
      return reply.status(result.action === 'updated' ? 200 : 201).send(result);
    } finally {
      // Clean up temp file
      if (existsSync(tmpPath)) {
        try {
          rmSync(tmpPath);
        } catch {
          /* best-effort */
        }
      }
    }
  });

  // ── DELETE /api/connectors/plugins/:id — uninstall a plugin ──

  app.delete(
    '/api/connectors/plugins/:id',
    async (
      req: FastifyRequest<{ Params: { id: string }; Querystring: { clearConfig?: string } }>,
      reply: FastifyReply,
    ) => {
      const accessErr = requirePluginWriteAccess(req);
      if (accessErr) return reply.status(accessErr.status).send({ error: accessErr.error });

      const { id } = req.params;
      const clearConfig = req.query.clearConfig === 'true';

      const projectRoot = resolveActiveProjectRoot();
      const result = uninstallPlugin(projectRoot, id, { clearConfig });

      if ('code' in result) {
        return reply.status(404).send({ error: result.message, code: result.code });
      }

      // Clear in-memory registries so the deleted plugin doesn't ghost in status responses.
      // Must happen BEFORE gateway reload (which re-registers surviving plugins).
      unregisterExternalConnectorMeta(id);
      unregisterConnectorDefinition(id);

      // Invalidate manifest cache so status/config endpoints drop removed plugin
      invalidateManifestCache();

      // Fire config event to trigger gateway reload (scope: 'file' = unconditional restart)
      configEventBus.emitChange({
        source: 'config-store',
        scope: 'file',
        changedKeys: [],
        changeSetId: createChangeSetId(),
        timestamp: Date.now(),
      });

      req.log.info({ id, clearConfig }, '[ConnectorPlugins] Plugin uninstalled');
      return reply.send(result);
    },
  );
};
