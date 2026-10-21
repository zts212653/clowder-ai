import type { WebhookContribution } from '@clowder-ai/plugin-contract';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';

const RESERVED_WEBHOOK_PATH_SEGMENTS = new Set(['config', 'test', 'enable', 'disable', 'actions', 'operations']);
const LITERAL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PARAMETER_SEGMENT = /^:[A-Za-z_][A-Za-z0-9_]*$/;

export interface DeclaredPluginWebhook {
  readonly contributionId: string;
  readonly path: string;
  readonly methods: readonly string[];
  readonly anonymous: boolean;
}

export function validateDeclaredWebhooks(webhooks: readonly WebhookContribution[]): void {
  const previous: WebhookContribution[] = [];
  for (const webhook of webhooks) {
    const segments = webhook.path.split('/');
    validatePattern(webhook.id, segments);
    for (const other of previous) {
      if (
        other.methods.some((method) => webhook.methods.includes(method)) &&
        overlap(segments, other.path.split('/'))
      ) {
        refuse(`Webhook contribution ${webhook.id} has an ambiguous path with ${other.id}`);
      }
    }
    previous.push(webhook);
  }
}

function validatePattern(id: string, segments: string[]): void {
  const firstSegment = segments[0] ?? '';
  if (RESERVED_WEBHOOK_PATH_SEGMENTS.has(firstSegment)) {
    refuse(`Webhook contribution ${id} uses reserved path segment ${firstSegment}`);
  }
  const parameters = segments.filter((segment) => PARAMETER_SEGMENT.test(segment));
  if (
    !LITERAL_SEGMENT.test(firstSegment) ||
    segments.some((segment) => !LITERAL_SEGMENT.test(segment) && !PARAMETER_SEGMENT.test(segment)) ||
    new Set(parameters).size !== parameters.length
  ) {
    refuse(`Webhook contribution ${id} has an invalid path pattern`);
  }
}

function refuse(message: string): never {
  throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', message);
}

function overlap(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((segment, i) => segment === right[i] || segment.startsWith(':') || right[i]?.startsWith(':'))
  );
}

/** Match raw URL segments; encoded slashes remain part of one parameter. */
function matches(pattern: string, rawPath: string, recognizeLiteralAliases = false): boolean {
  const patternSegments = pattern.split('/');
  const rawSegments = rawPath.split('/');
  return (
    patternSegments.length === rawSegments.length &&
    patternSegments.every((segment, i) => {
      const raw = rawSegments[i] ?? '';
      try {
        const decoded = decodeURIComponent(raw);
        if (!segment.startsWith(':')) return segment === raw || (recognizeLiteralAliases && segment === decoded);
        return (
          decoded.length > 0 &&
          !/[\\%]/.test(decoded) &&
          !Array.from(decoded).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
          decoded.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
        );
      } catch {
        return false;
      }
    })
  );
}

export function resolveDeclaredWebhook(
  webhooks: readonly WebhookContribution[],
  rawPath: string,
  method?: string,
): DeclaredPluginWebhook | undefined {
  const matching = webhooks.filter((candidate) => matches(candidate.path, rawPath, true));
  // Reject encoded aliases of declared literals before selecting a handler.
  // A spelling change must not switch a request to another authority boundary.
  if (matching.some((candidate) => !matches(candidate.path, rawPath))) return undefined;
  const methodMatch = matching.find((candidate) => candidate.methods.some((allowed) => allowed === method));
  const selected = methodMatch ?? matching[0];
  if (!selected) return undefined;
  return {
    contributionId: selected.id,
    path: selected.path,
    // With method-scoped admission there is at most one matching handler.
    // A method miss exposes all methods at this path without invoking a handler.
    methods: methodMatch ? methodMatch.methods : [...new Set(matching.flatMap((candidate) => candidate.methods))],
    anonymous: selected.verificationSecretRef !== undefined,
  };
}
