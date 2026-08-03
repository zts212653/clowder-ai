import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  requireCapabilityWriteOwner,
  requireLocalCapabilityWriteRequest,
  resolveCapabilityWriteSessionUserId,
} from '../../config/capabilities/capability-write-guards.js';
import type { WeChatVisibleReaderArmStore } from './WeChatVisibleReaderArmStore.js';
import type { WeChatVisibleReaderMetrics } from './WeChatVisibleReaderMetrics.js';

export interface WeChatVisibleReaderArmRoutesOptions {
  armStore: WeChatVisibleReaderArmStore;
  metrics: WeChatVisibleReaderMetrics;
  isPluginEnabled: () => boolean | Promise<boolean>;
}

function requireArmOwner(request: FastifyRequest, reply: FastifyReply): string | null {
  const localError = requireLocalCapabilityWriteRequest(request);
  if (localError) {
    reply.status(localError.status);
    void reply.send({ error: localError.error });
    return null;
  }

  const operator = resolveCapabilityWriteSessionUserId(request);
  if (!operator) {
    reply.status(401);
    void reply.send({ error: 'WeChat read authorization requires an authenticated owner session' });
    return null;
  }

  const ownerError = requireCapabilityWriteOwner(operator, { allowMissingOwner: true });
  if (ownerError) {
    reply.status(ownerError.status);
    void reply.send({ error: 'WeChat read authorization requires configured owner authorization' });
    return null;
  }
  return operator;
}

export function registerWeChatVisibleReaderArmRoutes(
  app: FastifyInstance,
  options: WeChatVisibleReaderArmRoutesOptions,
): void {
  const { armStore, metrics, isPluginEnabled } = options;

  app.addHook('onClose', async () => {
    armStore.disarm();
  });

  app.get('/api/plugins/wechat-visible-reader/arm', async (request, reply) => {
    if (!requireArmOwner(request, reply)) return;
    const enabled = await isPluginEnabled();
    if (!enabled) armStore.disarm();
    return { enabled, ...armStore.status(), metrics: metrics.snapshot() };
  });

  app.post<{ Body: { minutes?: unknown } }>('/api/plugins/wechat-visible-reader/arm', async (request, reply) => {
    const operator = requireArmOwner(request, reply);
    if (!operator) return;
    const enabled = await isPluginEnabled();
    if (!enabled) {
      armStore.disarm();
      reply.status(409);
      return { error: 'Enable the WeChat visible reader plugin before authorizing a read' };
    }

    const minutes = request.body?.minutes;
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 30) {
      reply.status(400);
      return { error: 'minutes must be a whole number between 1 and 30' };
    }
    return { enabled: true, ...armStore.arm({ operator, minutes }) };
  });

  app.delete('/api/plugins/wechat-visible-reader/arm', async (request, reply) => {
    if (!requireArmOwner(request, reply)) return;
    const enabled = await isPluginEnabled();
    return { enabled, ...armStore.disarm() };
  });
}
