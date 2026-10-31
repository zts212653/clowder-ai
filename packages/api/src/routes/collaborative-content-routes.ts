import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_EDITOR_BRIDGE_MAX_CONTENT_BYTES,
  EditorBridgeError,
  type EditorBridgeService,
} from '../domains/collaborative-content/editor-bridge/service.js';
import {
  EditorSessionError,
  type EditorSessionService,
} from '../domains/collaborative-content/editor-session-service.js';
import {
  type EditorSurfaceLocatorPort,
  surfaceAdmissionMatchesSession,
} from '../domains/collaborative-content/editor-surface-admission.js';
import { ContentOwnerNotFoundError } from '../domains/video-studio/content-owner/service.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';

const EDITOR_BRIDGE_JSON_ENVELOPE_BYTES = 16 * 1024;
const sessionTokenSchema = z
  .string()
  .min(32)
  .max(256)
  .refine((value) => !value.includes('\0'));
const sessionRefSchema = z.string().regex(/^editor-session:[0-9a-f]{64}$/);
const contentRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('\0'));
const operationIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('\0'));
export interface CollaborativeContentRouteDeps {
  readonly ownerUserId: string;
  readonly bridge: Pick<EditorBridgeService, 'load' | 'settle'>;
  readonly sessions?: Pick<EditorSessionService, 'issue' | 'prepareResume' | 'resume' | 'closeRef'>;
  readonly surfaces?: EditorSurfaceLocatorPort;
  readonly maxContentBytes?: number;
}

/**
 * Renderer bridge HTTP adapter. It is intentionally registration-only until
 * F202 can admit the public content-editor-provider contract from its canonical
 * package. No route accepts contentRef or actor identity from the renderer.
 */
export function registerCollaborativeContentRoutes(app: FastifyInstance, deps: CollaborativeContentRouteDeps): void {
  if ((deps.sessions === undefined) !== (deps.surfaces === undefined)) {
    throw new TypeError('collaborative content session routes require both sessions and surfaces');
  }
  if (deps.sessions && deps.surfaces) registerEditorSessionRoutes(app, deps.sessions, deps.surfaces, deps.ownerUserId);

  const maxContentBytes = deps.maxContentBytes ?? DEFAULT_EDITOR_BRIDGE_MAX_CONTENT_BYTES;
  if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes < 1) {
    throw new TypeError('maxContentBytes must be a positive safe integer');
  }
  const bridgeRequestSchema = createBridgeRequestSchema(maxContentBytes);
  const bodyLimit = Math.ceil(maxContentBytes / 3) * 4 + EDITOR_BRIDGE_JSON_ENVELOPE_BYTES;

  app.post('/api/collaborative-content/editor-bridge', { bodyLimit }, async (request, reply) => {
    const userId = resolveDirectLocalAuthorizationUserId(request);
    if (!userId) return reply.status(401).send({ ok: false, error: { code: 'identity_required' } });
    if (userId !== deps.ownerUserId) return reply.status(403).send({ error: { code: 'content_access_denied' } });

    return handleEditorBridgeRequest(reply, request.body, userId, bridgeRequestSchema, deps.bridge);
  });
}

async function handleEditorBridgeRequest(
  reply: FastifyReply,
  requestBody: unknown,
  userId: string,
  bridgeRequestSchema: ReturnType<typeof createBridgeRequestSchema>,
  bridge: CollaborativeContentRouteDeps['bridge'],
): Promise<unknown> {
  const parsed = bridgeRequestSchema.safeParse(requestBody);
  if (!parsed.success) {
    return reply.status(400).send({
      ok: false,
      error: { code: 'invalid_bridge_request', details: parsed.error.issues },
    });
  }
  const principal = { kind: 'human' as const, subjectId: userId };

  try {
    if (parsed.data.operation === 'content.load') {
      const loaded = await bridge.load({ sessionToken: parsed.data.sessionToken, principal });
      return reply.send({
        ok: true,
        value: {
          contentIdentity: loaded.contentIdentity,
          fileName: loaded.fileName,
          ownerRevision: loaded.ownerRevision,
          blobDigest: loaded.blobDigest,
          mediaType: loaded.mediaType,
          bytesBase64: loaded.bytes.toString('base64'),
        },
      });
    }
    if (parsed.data.operation === 'surface.fontMetric') {
      // Frozen GenOffice accepts null and falls back to the packaged fonts.
      // The Host performs no filesystem font lookup for a dedicated-origin renderer.
      return reply.send({ ok: true, value: null });
    }

    const result = await bridge.settle({
      sessionToken: parsed.data.sessionToken,
      principal,
      expectedOwnerRevision: parsed.data.payload.expectedOwnerRevision,
      operationId: parsed.data.payload.operationId,
      bytes: Buffer.from(parsed.data.payload.bytesBase64, 'base64'),
    });
    if (result.status === 'applied') {
      return reply.send({
        ok: true,
        value: {
          receiptId: result.receipt.receiptId,
          ownerRevision: result.receipt.ownerRevision,
          blobDigest: result.receipt.blobDigest,
        },
      });
    }
    if (result.status === 'conflict') {
      return reply.status(409).send({
        ok: false,
        error: {
          code: 'owner_revision_conflict',
          message: 'Owner revision changed',
          actualOwnerRevision: result.actualOwnerRevision,
        },
      });
    }
    if (result.status === 'rejected') {
      return reply.status(result.reason === 'OPERATION_ID_REUSED' ? 409 : 403).send({
        ok: false,
        error: { code: result.reason.toLowerCase(), message: 'Editor settlement rejected' },
      });
    }
    return reply.status(409).send({
      ok: false,
      error: { code: result.reason.toLowerCase(), message: 'Editor session unavailable' },
    });
  } catch (error: unknown) {
    return sendBridgeError(reply, error);
  }
}

function registerEditorSessionRoutes(
  app: FastifyInstance,
  sessions: NonNullable<CollaborativeContentRouteDeps['sessions']>,
  surfaces: EditorSurfaceLocatorPort,
  ownerUserId: string,
): void {
  app.post('/api/collaborative-content/editor-sessions', async (request, reply) => {
    const userId = resolveDirectLocalAuthorizationUserId(request);
    if (!userId) return reply.status(401).send({ error: { code: 'identity_required' } });
    if (userId !== ownerUserId) return reply.status(403).send({ error: { code: 'content_access_denied' } });
    const body = z.object({ contentRef: contentRefSchema }).strict().safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: 'invalid_session_request' } });
    try {
      const issued = await sessions.issue({
        contentRef: body.data.contentRef,
        principal: { kind: 'human', subjectId: userId },
      });
      return reply.status(201).send({
        sessionRef: issued.sessionRef,
        contentRef: issued.contentRef,
        providerId: issued.providerId,
        ownerRevision: issued.ownerRevision,
        bindingRevision: issued.bindingRevision,
      });
    } catch (error: unknown) {
      return sendBridgeError(reply, error);
    }
  });

  app.post('/api/collaborative-content/editor-sessions/:sessionRef/resume', async (request, reply) => {
    const userId = resolveDirectLocalAuthorizationUserId(request);
    if (!userId) return reply.status(401).send({ error: { code: 'identity_required' } });
    if (userId !== ownerUserId) return reply.status(403).send({ error: { code: 'content_access_denied' } });
    const params = z.object({ sessionRef: sessionRefSchema }).strict().safeParse(request.params);
    const body = z
      .object({})
      .strict()
      .safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: { code: 'invalid_session_resume' } });
    }
    const principal = { kind: 'human' as const, subjectId: userId };
    try {
      const candidate = await sessions.prepareResume({ sessionRef: params.data.sessionRef, principal });
      const surface = await surfaces.resolve(candidate);
      if (!surface || !surfaceAdmissionMatchesSession(surface, candidate)) {
        return reply.status(409).send({ error: { code: 'editor_surface_unavailable' } });
      }
      const active = await sessions.resume({
        sessionRef: params.data.sessionRef,
        principal,
        surfaceIntegrity: surface.surfaceIntegrity,
      });
      return reply.send({
        sessionRef: active.sessionRef,
        sessionToken: active.sessionToken,
        surface,
      });
    } catch (error: unknown) {
      return sendBridgeError(reply, error);
    }
  });

  app.delete('/api/collaborative-content/editor-sessions/:sessionRef', async (request, reply) => {
    const userId = resolveDirectLocalAuthorizationUserId(request);
    if (!userId) return reply.status(401).send({ error: { code: 'identity_required' } });
    if (userId !== ownerUserId) return reply.status(403).send({ error: { code: 'content_access_denied' } });
    const params = z.object({ sessionRef: sessionRefSchema }).strict().safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: { code: 'invalid_session_ref' } });
    try {
      await sessions.closeRef({
        sessionRef: params.data.sessionRef,
        principal: { kind: 'human', subjectId: userId },
      });
      return reply.status(204).send();
    } catch (error: unknown) {
      return sendBridgeError(reply, error);
    }
  });
}

function createBridgeRequestSchema(maxContentBytes: number) {
  const canonicalBase64Schema = z
    .string()
    .min(1)
    .max(Math.ceil(maxContentBytes / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
    .refine((value) => Buffer.from(value, 'base64').toString('base64') === value)
    .refine((value) => Buffer.from(value, 'base64').byteLength <= maxContentBytes);
  return z.discriminatedUnion('operation', [
    z
      .object({
        v: z.literal(1),
        sessionToken: sessionTokenSchema,
        operation: z.literal('content.load'),
        payload: z.object({}).strict(),
      })
      .strict(),
    z
      .object({
        v: z.literal(1),
        sessionToken: sessionTokenSchema,
        operation: z.literal('content.settle'),
        payload: z
          .object({
            expectedOwnerRevision: z.number().int().nonnegative(),
            operationId: operationIdSchema,
            bytesBase64: canonicalBase64Schema,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        v: z.literal(1),
        sessionToken: sessionTokenSchema,
        operation: z.literal('surface.fontMetric'),
        payload: z.object({ family: z.string().trim().min(1).max(128) }).strict(),
      })
      .strict(),
  ]);
}

function sendBridgeError(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof EditorBridgeError) {
    const status = error.code === 'PRINCIPAL_MISMATCH' ? 403 : error.code === 'CONTENT_TOO_LARGE' ? 413 : 415;
    return reply.status(status).send({
      ok: false,
      error: { code: error.code.toLowerCase(), message: error.message },
    });
  }
  if (error instanceof EditorSessionError) {
    return reply.status(error.code === 'SESSION_NOT_FOUND' ? 404 : 409).send({
      ok: false,
      error: { code: error.code.toLowerCase(), message: 'Editor session unavailable' },
    });
  }
  if (error instanceof ContentOwnerNotFoundError) {
    return reply.status(404).send({
      ok: false,
      error: { code: 'content_not_found', message: 'Content is unavailable' },
    });
  }
  throw error;
}
