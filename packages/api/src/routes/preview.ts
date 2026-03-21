import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { AuditEventTypes, getEventAuditLog } from '../domains/cats/services/index.js';
import type { PortDiscoveryService } from '../domains/preview/port-discovery.js';
import { validatePort } from '../domains/preview/port-validator.js';

interface PreviewRouteOpts {
  portDiscovery: PortDiscoveryService;
  gatewayPort: number;
  runtimePorts?: number[];
  /** F120 Phase C: emit socket events to a specific room */
  socketEmit?: (event: string, data: unknown, room: string) => void;
}

export const previewRoutes: FastifyPluginAsync<PreviewRouteOpts> = async (app, opts) => {
  const { portDiscovery, gatewayPort, runtimePorts } = opts;
  const auditLog = getEventAuditLog();
  const gatewayAvailable = gatewayPort > 0;

  app.get('/api/preview/status', async () => {
    return { available: gatewayAvailable, gatewayPort };
  });

  app.post<{ Body: { port: number; host?: string } }>('/api/preview/validate-port', async (req) => {
    const { port, host } = req.body;
    const result = validatePort(port, { host, gatewaySelfPort: gatewayPort, runtimePorts });
    // Audit: log preview open attempt
    if (result.allowed) {
      auditLog
        .append({
          type: AuditEventTypes.BROWSER_PREVIEW_OPEN,
          data: { port, host: host ?? 'localhost', gatewayPort },
        })
        .catch(() => {});
    }
    return result;
  });

  app.get<{ Querystring: { worktreeId?: string } }>('/api/preview/discovered', async (req) => {
    return portDiscovery.getDiscoveredPorts(req.query.worktreeId);
  });

  // P1-3: Consolidated audit endpoints for preview lifecycle
  app.post<{ Body: { port: number; host?: string; threadId?: string } }>('/api/preview/open', async (req) => {
    if (!gatewayAvailable) {
      return { allowed: false, reason: 'Preview gateway unavailable' };
    }
    const { port, host, threadId } = req.body;
    const result = validatePort(port, { host, gatewaySelfPort: gatewayPort, runtimePorts });
    if (result.allowed) {
      auditLog
        .append({
          type: AuditEventTypes.BROWSER_PREVIEW_OPEN,
          threadId,
          data: { port, host: host ?? 'localhost', gatewayPort },
        })
        .catch(() => {});
    }
    return {
      ...result,
      gatewayUrl: result.allowed ? `http://localhost:${gatewayPort}/?__preview_port=${port}` : undefined,
    };
  });

  app.post<{ Body: { port: number; threadId?: string } }>('/api/preview/close', async (req) => {
    const { port, threadId } = req.body;
    auditLog
      .append({
        type: AuditEventTypes.BROWSER_PREVIEW_CLOSE,
        threadId,
        data: { port },
      })
      .catch(() => {});
    return { ok: true };
  });

  app.post<{ Body: { port: number; url: string; threadId?: string } }>('/api/preview/navigate', async (req) => {
    const { port, url, threadId } = req.body;
    auditLog
      .append({
        type: AuditEventTypes.BROWSER_PREVIEW_NAVIGATE,
        threadId,
        data: { port, url },
      })
      .catch(() => {});
    return { ok: true };
  });

  // F120 Phase C: Cat-initiated auto-open — skips toast, directly opens browser panel
  app.post<{ Body: { port: number; path?: string; threadId?: string; worktreeId?: string } }>(
    '/api/preview/auto-open',
    async (req) => {
      if (!gatewayAvailable) {
        return { allowed: false, reason: 'Preview gateway unavailable' };
      }
      const { port, path, threadId, worktreeId } = req.body;
      const result = validatePort(port, { host: 'localhost', gatewaySelfPort: gatewayPort, runtimePorts });
      if (!result.allowed) {
        return result;
      }
      // Dual-broadcast: when worktreeId is provided, emit to both the scoped room
      // AND preview:global so the matching session always receives the event
      // regardless of frontend room-join timing. The frontend's shouldAcceptAutoOpen
      // filter (fail-closed) prevents cross-session leakage.
      const eventData = { port, path, threadId, worktreeId };
      if (worktreeId) {
        opts.socketEmit?.('preview:auto-open', eventData, `worktree:${worktreeId}`);
        opts.socketEmit?.('preview:auto-open', eventData, 'preview:global');
      } else {
        opts.socketEmit?.('preview:auto-open', eventData, 'preview:global');
      }
      auditLog
        .append({
          type: AuditEventTypes.BROWSER_PREVIEW_OPEN,
          threadId,
          data: { port, host: 'localhost', gatewayPort, autoOpen: true, worktreeId },
        })
        .catch(() => {});
      return { allowed: true, port, path };
    },
  );

  // F120 Phase C: Screenshot upload — converts data URL to file
  app.post<{ Body: { dataUrl: string; threadId?: string } }>('/api/preview/screenshot', async (req, reply) => {
    const { dataUrl, threadId } = req.body;
    const match = dataUrl?.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
    if (!match) {
      return reply.status(400).send({ error: 'Invalid data URL — expected data:image/{png|jpeg|webp};base64,...' });
    }
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1]!;
    const buffer = Buffer.from(match[2]!, 'base64');
    const uploadDir = resolve(process.env.UPLOAD_DIR ?? './uploads');
    await mkdir(uploadDir, { recursive: true });
    const filename = `screenshot-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
    await writeFile(join(uploadDir, filename), buffer);
    auditLog
      .append({
        type: AuditEventTypes.BROWSER_PREVIEW_OPEN,
        threadId,
        data: { action: 'screenshot', filename },
      })
      .catch(() => {});
    return { url: `/uploads/${filename}` };
  });
};
