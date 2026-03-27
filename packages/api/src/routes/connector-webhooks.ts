/**
 * Connector Webhook Routes
 * POST /api/connectors/:connectorId/webhook — Generic webhook entry point
 *
 * Receives platform webhooks (Feishu event callbacks, etc.),
 * delegates to registered platform adapters for parsing and routing.
 *
 * F088 Multi-Platform Chat Gateway
 */

import { getConnectorDefinition } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';

export interface ConnectorWebhookHandler {
  readonly connectorId: string;
  handleWebhook(body: unknown, headers: Record<string, string>, rawBody?: Buffer): Promise<WebhookHandleResult>;
}

export type WebhookHandleResult =
  | { kind: 'challenge'; response: Record<string, unknown> }
  | { kind: 'processed'; messageId?: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; status: number; message: string };

export interface ConnectorWebhookRoutesOptions {
  readonly handlers: Map<string, ConnectorWebhookHandler>;
}

export const connectorWebhookRoutes: FastifyPluginAsync<ConnectorWebhookRoutesOptions> = async (app, opts) => {
  const { handlers } = opts;

  // Capture raw body for HMAC verification (KD-11, F141).
  // Scoped to this plugin — does not affect other routes.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req: unknown, body: Buffer, done: (err: Error | null, body?: unknown) => void) => {
      (_req as { rawBody: Buffer }).rawBody = body;
      try {
        done(null, JSON.parse(body.toString()));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  app.post<{ Params: { connectorId: string } }>('/api/connectors/:connectorId/webhook', async (request, reply) => {
    const { connectorId } = request.params;

    // Check connector exists in registry
    const def = getConnectorDefinition(connectorId);
    if (!def) {
      return reply.status(404).send({ error: `Unknown connector: ${connectorId}` });
    }

    // Check handler registered
    const handler = handlers.get(connectorId);
    if (!handler) {
      return reply.status(501).send({ error: `No handler for connector: ${connectorId}` });
    }

    const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody;
    const result = await handler.handleWebhook(request.body, request.headers as Record<string, string>, rawBody);

    switch (result.kind) {
      case 'challenge':
        return reply.status(200).send(result.response);
      case 'processed':
        return reply.status(200).send({ ok: true, messageId: result.messageId });
      case 'skipped':
        return reply.status(200).send({ ok: true, skipped: result.reason });
      case 'error':
        return reply.status(result.status).send({ error: result.message });
    }
  });
};
