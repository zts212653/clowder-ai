import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { RuntimeDeploymentLedger } from '../domains/runtime-deployment/RuntimeDeploymentLedger.js';
import { isDirectLoopbackRequest } from '../utils/loopback-request.js';

export interface RuntimeDeploymentRoutesOptions {
  readonly ledger: RuntimeDeploymentLedger;
  readonly deploymentId: string;
  readonly onReady?: () => void | Promise<void>;
}

const readinessSchema = z
  .object({
    bootId: z.string().min(1),
    service: z.literal('web'),
  })
  .strict();

export const runtimeDeploymentRoutes: FastifyPluginAsync<RuntimeDeploymentRoutesOptions> = async (app, options) => {
  app.post('/api/runtime-deployment/readiness', async (request, reply) => {
    if (!isDirectLoopbackRequest(request)) {
      reply.status(403);
      return { error: 'Runtime readiness facts require a direct loopback caller' };
    }
    const parsed = readinessSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid runtime readiness fact', details: parsed.error.issues };
    }
    try {
      const boot = await options.ledger.markReady({
        deploymentId: options.deploymentId,
        bootId: parsed.data.bootId,
        services: [parsed.data.service],
      });
      await options.onReady?.();
      return { status: 'ok', boot };
    } catch (error) {
      reply.status(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
};
