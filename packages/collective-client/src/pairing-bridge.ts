import {
  type CollectivePairingBridgeErrorCode,
  type CollectivePairingHostRequest,
  type CollectivePairingIntent,
  type CollectivePairingMessage,
  collectivePairingHostRequestSchema,
} from '@cat-cafe/shared';
import type { ClientPhase } from './client-types.js';

export interface PairingRequestEvent {
  readonly origin: string;
  readonly source: unknown;
  readonly data: unknown;
}

export interface FreshPairingIntentOptions {
  readonly collectiveId: string;
  readonly hostOrigin: string;
  readonly serviceUrl: string;
  readonly createNonce: () => string;
  readonly requestIntent: (input: {
    readonly collectiveId: string;
    readonly hostOrigin: string;
    readonly nonce: string;
  }) => Promise<CollectivePairingIntent>;
  readonly postToHost: (message: CollectivePairingMessage, targetOrigin: string) => void;
}

interface PairingAvailabilityOptions {
  readonly collectiveId: string | undefined;
  readonly unavailableCode?: Exclude<CollectivePairingBridgeErrorCode, 'pairing_failed'>;
  readonly hostOrigin: string;
  readonly serviceUrl: string;
  readonly postToHost: FreshPairingIntentOptions['postToHost'];
}

interface PairingResponseOptions extends Omit<FreshPairingIntentOptions, 'collectiveId'> {
  readonly collectiveId: string | undefined;
  readonly unavailableCode?: Exclude<CollectivePairingBridgeErrorCode, 'pairing_failed'>;
  readonly classifyError?: (error: unknown) => CollectivePairingBridgeErrorCode;
}

export function resolvePairingAuthority(input: {
  readonly phase: ClientPhase;
  readonly hasSession: boolean;
  readonly collective: { readonly collectiveId: string; readonly role: 'steward' | 'member' } | undefined;
}): Pick<PairingAvailabilityOptions, 'collectiveId' | 'unavailableCode'> {
  if (input.phase === 'unavailable') return { collectiveId: undefined, unavailableCode: 'client_unavailable' };
  if (!input.hasSession) return { collectiveId: undefined, unavailableCode: 'session_required' };
  if (!input.collective) return { collectiveId: undefined, unavailableCode: 'collective_required' };
  return { collectiveId: input.collective.collectiveId, unavailableCode: 'client_unavailable' };
}

export function trustedPairingHostRequest(
  event: PairingRequestEvent,
  hostOrigin: string,
  parent: unknown,
): CollectivePairingHostRequest | undefined {
  if (event.origin !== hostOrigin || event.source !== parent) return undefined;
  const parsed = collectivePairingHostRequestSchema.safeParse(event.data);
  return parsed.success ? parsed.data : undefined;
}

export function isTrustedPairingRequest(event: PairingRequestEvent, hostOrigin: string, parent: unknown): boolean {
  return trustedPairingHostRequest(event, hostOrigin, parent)?.type === 'collective:request-pairing';
}

export function announcePairingAvailability(options: PairingAvailabilityOptions): void {
  options.postToHost(
    options.collectiveId
      ? { type: 'collective:pairing-ready', serviceUrl: options.serviceUrl }
      : {
          type: 'collective:pairing-error',
          serviceUrl: options.serviceUrl,
          code: options.unavailableCode ?? 'session_required',
        },
    options.hostOrigin,
  );
}

export async function emitFreshPairingIntent(options: FreshPairingIntentOptions): Promise<void> {
  const intent = await options.requestIntent({
    collectiveId: options.collectiveId,
    hostOrigin: options.hostOrigin,
    nonce: options.createNonce(),
  });
  options.postToHost(
    {
      type: 'collective:pairing-intent',
      serviceUrl: options.serviceUrl,
      intent,
    },
    options.hostOrigin,
  );
}

export async function respondToPairingRequest(
  options: PairingResponseOptions,
): Promise<'paired' | CollectivePairingBridgeErrorCode> {
  if (!options.collectiveId) {
    announcePairingAvailability(options);
    return options.unavailableCode ?? 'session_required';
  }
  try {
    await emitFreshPairingIntent({ ...options, collectiveId: options.collectiveId });
    return 'paired';
  } catch (error) {
    const code = options.classifyError?.(error) ?? 'pairing_failed';
    options.postToHost({ type: 'collective:pairing-error', serviceUrl: options.serviceUrl, code }, options.hostOrigin);
    return code;
  }
}
