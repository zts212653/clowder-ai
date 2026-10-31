import { z } from 'zod';
import type { PushSubscriptionRecord } from '../domains/cats/services/stores/ports/PushSubscriptionStore.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export type PushDeliveryStatus = 'ok' | 'error' | 'not_attempted';

export interface PushDeliverySnapshot {
  lastAttemptAt: number | null;
  lastHttpStatus: number | null;
  lastResult: PushDeliveryStatus;
  lastError: string | null;
}

export interface PushDeliverySummary {
  attempted: number;
  delivered: number;
  failed: number;
  removed: number;
}

export const subscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string().min(1),
      auth: z.string().min(1),
    }),
  }),
  userAgent: z.string().max(500).optional(),
});

export const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

export function resolveUserId(request: import('fastify').FastifyRequest): string | null {
  return resolveHeaderUserId(request);
}

export function toDeliverySummary(delivery: Partial<PushDeliverySummary> | null | undefined): PushDeliverySummary {
  return {
    attempted: delivery?.attempted ?? 0,
    delivered: delivery?.delivered ?? 0,
    failed: delivery?.failed ?? 0,
    removed: delivery?.removed ?? 0,
  };
}

export function describeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.host}...${endpoint.slice(-12)}`;
  } catch {
    return `invalid...${endpoint.slice(-12)}`;
  }
}

export function summarizeUserAgent(userAgent?: string): string {
  if (!userAgent) return 'unknown';
  if (userAgent.includes('Edg/')) return 'edge';
  if (userAgent.includes('Chrome/')) return 'chrome';
  if (userAgent.includes('Firefox/')) return 'firefox';
  if (userAgent.includes('Safari/')) return 'safari';
  return 'other';
}

export function summarizeTargets(subscriptions: PushSubscriptionRecord[]): Array<Record<string, unknown>> {
  return subscriptions.map((sub) => ({
    endpoint: describeEndpoint(sub.endpoint),
    createdAt: sub.createdAt,
    uaFamily: summarizeUserAgent(sub.userAgent),
  }));
}
