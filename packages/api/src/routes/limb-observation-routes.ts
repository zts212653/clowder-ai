import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LimbEmbodimentBindingStore } from '../domains/limb/LimbEmbodimentBindingStore.js';
import {
  createLimbObservationRouter,
  type LimbObservation,
  type LimbObservationReceiptStore,
  type LimbTranscriptDelivery,
} from '../domains/limb/LimbObservationRouter.js';

const identifier = z.string().min(1).max(128);
const common = {
  v: z.literal(1),
  observationId: identifier,
  nodeId: identifier,
  occurredAt: z.string().datetime({ offset: true }),
  sessionId: identifier,
};
const observationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...common,
      kind: z.literal('touch'),
      payload: z
        .object({
          gesture: z.enum(['tap', 'stroke']),
          durationMs: z.number().int().min(0).max(10_000),
          confidence: z.number().min(0).max(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('transcript'),
      payload: z
        .object({
          interactionId: identifier,
          text: z.string().min(1).max(4_096),
          language: z.string().min(1).max(32).optional(),
          captureDurationMs: z.number().int().min(100).max(30_000),
        })
        .strict(),
    })
    .strict(),
]);
const bodySchema = z.object({ observation: observationSchema }).strict();

interface PairingLookup {
  findByApiKey(apiKey: string):
    | {
        readonly nodeId: string;
        readonly capabilities: ReadonlyArray<{ readonly cap: string }>;
      }
    | undefined;
}

interface RegistryLookup {
  getNode(nodeId: string): { readonly status: string } | undefined;
}

export interface LimbObservationRoutesOptions {
  readonly pairingStore: PairingLookup;
  readonly limbRegistry: RegistryLookup;
  readonly bindingStore: LimbEmbodimentBindingStore;
  readonly receiptStore: LimbObservationReceiptStore;
  readonly delivery: LimbTranscriptDelivery;
  readonly now?: () => number;
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length);
  return token.length > 0 ? token : undefined;
}

export function registerLimbObservationRoutes(app: FastifyInstance, options: LimbObservationRoutesOptions): void {
  const router = createLimbObservationRouter(options);

  app.post('/api/limb/observations', async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }

    const apiKey = bearerToken(request.headers.authorization);
    const pairing = apiKey ? options.pairingStore.findByApiKey(apiKey) : undefined;
    if (!pairing || pairing.nodeId !== parsed.data.observation.nodeId) {
      return reply.status(403).send({ error: 'Invalid or unapproved limb credentials' });
    }

    const node = options.limbRegistry.getNode(pairing.nodeId);
    if (!node || node.status === 'offline') {
      return reply.status(403).send({ error: 'Limb node is not active' });
    }

    const requiredGrant = parsed.data.observation.kind === 'touch' ? 'limb.observe.touch' : 'limb.sensor.microphone';
    if (!pairing.capabilities.some((capability) => capability.cap === requiredGrant)) {
      return reply.status(403).send({ error: `Missing grant: ${requiredGrant}` });
    }

    const result = await router.route(parsed.data.observation as LimbObservation);
    switch (result.status) {
      case 'duplicate':
        return reply.send(result);
      case 'unbound':
      case 'stale':
        return reply.status(409).send(result);
      case 'reflex_only':
      case 'routed':
        return reply.status(202).send(result);
    }
  });
}
