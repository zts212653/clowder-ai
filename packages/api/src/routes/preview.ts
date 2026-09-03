import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { connect as netConnect } from 'node:net';
import { join } from 'node:path';
import {
  buildPreviewGatewayUrl,
  type CallbackPrincipal,
  type PreviewVisiblePageAdmission,
  previewVisiblePageAdmissionSchema,
} from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AuditEventTypes, type EventAuditLog, getEventAuditLog } from '../domains/cats/services/index.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { PortDiscoveryService } from '../domains/preview/port-discovery.js';
import { validatePort } from '../domains/preview/port-validator.js';
import { emitPreviewAutoOpen, type PreviewAutoOpenEventData } from '../domains/preview/preview-auto-open-delivery.js';
import { resolveDirectLocalAuthorizationUserId, resolveSessionUserId } from '../utils/request-identity.js';
import { getDefaultUploadDir } from '../utils/upload-paths.js';
import {
  type AgentKeyAuthRegistry,
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
} from './callback-auth-prehandler.js';
import { resolvePrincipalThread } from './callback-scope-helpers.js';

interface PreviewRouteOpts {
  portDiscovery: PortDiscoveryService;
  gatewayPort: number;
  runtimePorts?: number[];
  /** F120 Phase C: emit socket events to a specific room */
  socketEmit?: (event: string, data: unknown, room: string) => void;
  /** F120 × F284: emit with client acknowledgement (delivery receipts) */
  socketEmitWithAck?: (event: string, data: unknown, room: string, timeoutMs?: number) => Promise<unknown[]>;
  auditLog?: EventAuditLog;
  /** F120 × F284 review P1: auth registries + thread scope for auto-open */
  callbackRegistry?: CallbackAuthRegistry;
  agentKeyRegistry?: AgentKeyAuthRegistry;
  threadStore?: Pick<IThreadStore, 'get' | 'list'>;
}

type PreviewAutoOpenPrincipal = CallbackPrincipal | { kind: 'interactive'; userId: string };

/**
 * Mirror of the F131 workspace-navigate principal chain: callback principal
 * (invocation token / agent key) first, then an interactive session or a
 * direct loopback call with an explicit identity header. Anonymous requests
 * get null → 401.
 */
function resolveAutoOpenPrincipal(request: FastifyRequest): PreviewAutoOpenPrincipal | null {
  if (request.callbackPrincipal) return request.callbackPrincipal;
  const userId = resolveSessionUserId(request) ?? resolveDirectLocalAuthorizationUserId(request);
  return userId ? { kind: 'interactive', userId } : null;
}

async function resolveAutoOpenThreadId(
  principal: PreviewAutoOpenPrincipal,
  requestedThreadId: string | undefined,
  threadStore: PreviewRouteOpts['threadStore'],
): Promise<{ ok: true; threadId: string } | { ok: false; statusCode: number; error: string }> {
  if (principal.kind === 'interactive') {
    return requestedThreadId
      ? { ok: true, threadId: requestedThreadId }
      : { ok: false, statusCode: 400, error: 'threadId required for interactive preview auto-open' };
  }
  return resolvePrincipalThread(principal, requestedThreadId, {
    threadStore,
    threadStoreMissingError: 'Thread store not configured for preview auto-open',
    accessDeniedError: 'Thread access denied',
  });
}

function parseVisiblePageAdmission(
  value: unknown,
): { ok: true; admission?: PreviewVisiblePageAdmission } | { ok: false; details: unknown } {
  if (value === undefined) return { ok: true };
  const parsed = previewVisiblePageAdmissionSchema.safeParse(value);
  return parsed.success ? { ok: true, admission: parsed.data } : { ok: false, details: parsed.error.flatten() };
}

function createPreviewAutoOpenEvent(input: {
  port: number;
  path?: string;
  threadId: string;
  worktreeId?: string;
  gatewayPort: number;
  admission?: PreviewVisiblePageAdmission;
}): PreviewAutoOpenEventData {
  const event: PreviewAutoOpenEventData = {
    eventId: randomUUID(),
    port: input.port,
    path: input.path,
    threadId: input.threadId,
    worktreeId: input.worktreeId,
  };
  if (!input.admission) return event;
  return {
    ...event,
    targetOrigin: new URL(buildPreviewGatewayUrl(input.gatewayPort, input.port, input.path ?? '/')).origin,
    visiblePageAdmission: input.admission,
  };
}

function createPreviewAutoOpenAuditData(input: {
  event: PreviewAutoOpenEventData;
  delivery: Awaited<ReturnType<typeof emitPreviewAutoOpen>>;
  gatewayPort: number;
  worktreeId?: string;
  catId?: string;
}): Record<string, unknown> {
  const data: Record<string, unknown> = {
    port: input.event.port,
    host: 'localhost',
    gatewayPort: input.gatewayPort,
    autoOpen: true,
    worktreeId: input.worktreeId,
    catId: input.catId,
    eventId: input.event.eventId,
    deliveryStatus: input.delivery.deliveryStatus,
  };
  if (input.delivery.deliveryReason) data.deliveryReason = input.delivery.deliveryReason;
  if (input.delivery.visiblePageAdmission) data.visiblePageAdmission = input.delivery.visiblePageAdmission;
  return data;
}

/** F120 × F284: short TCP probe — is anything listening on this localhost port? */
function probeTargetPort(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ port, host: '127.0.0.1' });
    const done = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export const previewRoutes: FastifyPluginAsync<PreviewRouteOpts> = async (app, opts) => {
  const { portDiscovery, gatewayPort, runtimePorts } = opts;
  const auditLog = opts.auditLog ?? getEventAuditLog();
  const gatewayAvailable = gatewayPort > 0;
  if (opts.callbackRegistry) {
    registerCallbackAuthHook(app, opts.callbackRegistry, { agentKeyRegistry: opts.agentKeyRegistry });
  }

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
  app.post<{ Body: { port: number; host?: string; threadId?: string; catId?: string } }>(
    '/api/preview/open',
    async (req) => {
      if (!gatewayAvailable) {
        return { allowed: false, reason: 'Preview gateway unavailable' };
      }
      const { port, host, threadId, catId } = req.body;
      const result = validatePort(port, { host, gatewaySelfPort: gatewayPort, runtimePorts });
      if (result.allowed) {
        auditLog
          .append({
            type: AuditEventTypes.BROWSER_PREVIEW_OPEN,
            threadId,
            data: { port, host: host ?? 'localhost', gatewayPort, catId },
          })
          .catch(() => {});
      }
      return {
        ...result,
        gatewayUrl: result.allowed ? buildPreviewGatewayUrl(gatewayPort, port) : undefined,
      };
    },
  );

  app.post<{ Body: { port: number; threadId?: string; catId?: string } }>('/api/preview/close', async (req) => {
    const { port, threadId, catId } = req.body;
    auditLog
      .append({
        type: AuditEventTypes.BROWSER_PREVIEW_CLOSE,
        threadId,
        data: { port, catId },
      })
      .catch(() => {});
    return { ok: true };
  });

  app.post<{ Body: { port: number; url: string; threadId?: string; catId?: string } }>(
    '/api/preview/navigate',
    async (req) => {
      const { port, url, threadId, catId } = req.body;
      auditLog
        .append({
          type: AuditEventTypes.BROWSER_PREVIEW_NAVIGATE,
          threadId,
          data: { port, url, catId },
        })
        .catch(() => {});
      return { ok: true };
    },
  );

  // F120 Phase C: Cat-initiated auto-open — skips toast, directly opens browser panel.
  // F120 × F284 review P1: authenticated, exact-thread delivery. The threadId is
  // never trusted from the body alone — invocation callers derive it from the
  // invocation record, agent-key callers must name a thread in their own scope,
  // interactive sessions must name one explicitly. Anonymous → 401.
  app.post<{
    Body: {
      port: number;
      path?: string;
      threadId?: string;
      worktreeId?: string;
      catId?: string;
      visiblePageAdmission?: unknown;
    };
  }>('/api/preview/auto-open', async (req, reply) => {
    if (!gatewayAvailable) {
      return { allowed: false, reason: 'Preview gateway unavailable' };
    }
    const principal = resolveAutoOpenPrincipal(req);
    if (!principal) {
      reply.status(401);
      return { error: 'Authentication required' };
    }
    const { port, path, worktreeId } = req.body;
    const threadResolution = await resolveAutoOpenThreadId(principal, req.body.threadId, opts.threadStore);
    if (!threadResolution.ok) {
      reply.status(threadResolution.statusCode);
      return { error: threadResolution.error };
    }
    const threadId = threadResolution.threadId;
    const catId = principal.kind === 'interactive' ? req.body.catId : principal.catId;
    const userId = principal.userId;
    const result = validatePort(port, { host: 'localhost', gatewaySelfPort: gatewayPort, runtimePorts });
    if (!result.allowed) {
      return result;
    }
    const admissionResult = parseVisiblePageAdmission(req.body.visiblePageAdmission);
    if (!admissionResult.ok) {
      reply.status(400);
      return { error: 'Invalid visiblePageAdmission contract', details: admissionResult.details };
    }
    // F120 × F284: the event is delivered ONLY to the caller's user room
    // (server-enforced tenant scope — every socket auto-joins its own
    // user:<userId> room at connect). No legacy fire-and-forget broadcast:
    // preview:global / worktree rooms are joinable by any session and would
    // leak eventId/port/path/threadId to non-caller observers. Pre-ack
    // clients on the user room still receive the event; they just never
    // answer, which honestly surfaces as `unconfirmed`.
    const eventData = createPreviewAutoOpenEvent({
      port,
      path,
      threadId,
      worktreeId,
      gatewayPort,
      admission: admissionResult.admission,
    });
    const delivery = await emitPreviewAutoOpen(
      { socketEmit: opts.socketEmit, socketEmitWithAck: opts.socketEmitWithAck },
      eventData,
      `user:${userId}`,
    );
    auditLog
      .append({
        type: AuditEventTypes.BROWSER_PREVIEW_OPEN,
        threadId,
        data: createPreviewAutoOpenAuditData({
          event: eventData,
          delivery,
          gatewayPort,
          worktreeId,
          catId,
        }),
      })
      .catch(() => {});
    return { allowed: true, port, path, threadId, eventId: eventData.eventId, ...delivery };
  });

  // F120 × F284: Target liveness probe. Restored previews check this before
  // loading the iframe so a dead dev server shows an explicit
  // stopped/unavailable state (with a retry action) instead of an error shell.
  app.get<{ Querystring: { port?: string } }>('/api/preview/target-health', async (req, reply) => {
    const port = Number(req.query.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      reply.status(400);
      return { error: 'Invalid port' };
    }
    const validation = validatePort(port, { host: 'localhost', gatewaySelfPort: gatewayPort, runtimePorts });
    if (!validation.allowed) {
      return { port, reachable: false, reason: validation.reason };
    }
    return { port, reachable: await probeTargetPort(port) };
  });

  // F120 Phase C: Screenshot upload — converts data URL to file.
  // Avatar uploads have moved to /api/uploads/avatar (multipart). This route is
  // screenshots-only and uses the Fastify default bodyLimit (1 MiB), which is
  // adequate for in-iframe screenshot data URLs.
  app.post<{ Body: { dataUrl: string; threadId?: string } }>('/api/preview/screenshot', async (req, reply) => {
    const { dataUrl, threadId } = req.body;
    const match = dataUrl?.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
    if (!match) {
      return reply.status(400).send({ error: 'Invalid data URL — expected data:image/{png|jpeg|webp};base64,...' });
    }
    const imageFormat = match[1];
    const encodedImage = match[2];
    if (!imageFormat || !encodedImage) {
      return reply.status(400).send({ error: 'Invalid screenshot payload' });
    }
    const ext = imageFormat === 'jpeg' ? 'jpg' : imageFormat;
    const buffer = Buffer.from(encodedImage, 'base64');
    const uploadDir = getDefaultUploadDir(process.env.UPLOAD_DIR);
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
