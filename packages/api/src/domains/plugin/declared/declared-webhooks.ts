import type { WebhookContribution } from '@clowder-ai/plugin-contract';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';

const RESERVED_WEBHOOK_PATH_SEGMENTS = new Set(['config', 'test', 'enable', 'disable', 'actions', 'operations']);

export interface DeclaredPluginWebhook {
  readonly contributionId: string;
  readonly path: string;
  readonly methods: readonly ('GET' | 'POST' | 'PUT' | 'DELETE')[];
  readonly anonymous: boolean;
}

export function validateDeclaredWebhooks(webhooks: readonly WebhookContribution[]): void {
  const claimedMethods = new Map<string, Set<string>>();
  for (const webhook of webhooks) {
    const firstSegment = webhook.path.split('/', 1)[0];
    if (RESERVED_WEBHOOK_PATH_SEGMENTS.has(firstSegment)) {
      throw new ExternalPluginRuntimeError(
        'PROTOCOL_VIOLATION',
        `Webhook contribution ${webhook.id} uses reserved path segment ${firstSegment}`,
      );
    }
    const methods = claimedMethods.get(webhook.path) ?? new Set<string>();
    for (const method of webhook.methods) {
      if (methods.has(method)) {
        throw new ExternalPluginRuntimeError(
          'PROTOCOL_VIOLATION',
          `Webhook contribution ${webhook.id} duplicates ${method} ${webhook.path}`,
        );
      }
      methods.add(method);
    }
    claimedMethods.set(webhook.path, methods);
  }
}
