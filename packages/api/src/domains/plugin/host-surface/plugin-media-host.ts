import { type MediaReadInput, type MediaReadResult, validateMessagingRowInput } from '@clowder-ai/plugin-contract';
import { MessagingError } from '../../messaging/contract/host-types.js';
import type { MediaEntitlementLedger } from '../../messaging/media-entitlements.js';
import type { FileMessagingMediaLedger } from '../../messaging/media-ledger.js';

export interface PluginMediaHost {
  read(input: MediaReadInput): Promise<MediaReadResult>;
}

export interface MediaReadContext {
  readonly pluginInstanceId: string;
  readonly effectiveGrants: readonly string[];
}

const DENIED_MESSAGE = 'Media access denied';

/** One authority decision shared by the stdio Broker and in-process module carrier. */
export class PluginMediaReadService {
  constructor(
    private readonly options: {
      readonly ledger: Pick<FileMessagingMediaLedger, 'readChunk'>;
      readonly entitlements: Pick<MediaEntitlementLedger, 'isEntitled'>;
      readonly onRejected?: (reason: 'capability' | 'entitlement' | 'range') => void;
    },
  ) {}

  async read(context: MediaReadContext, input: MediaReadInput): Promise<MediaReadResult> {
    if (!context.effectiveGrants.includes('media.read')) {
      this.options.onRejected?.('capability');
      throw new MessagingError('PERMISSION', 'media.read capability is not granted');
    }
    const validated = validateMessagingRowInput('media.read', input);
    if (!validated.valid) {
      this.options.onRejected?.('range');
      throw new MessagingError('VALIDATION', 'media.read input is invalid');
    }
    let entitled = false;
    try {
      entitled = await this.options.entitlements.isEntitled(context.pluginInstanceId, validated.value.reference);
    } catch {
      // A missing/corrupt audit snapshot is never authority to release bytes.
      entitled = false;
    }
    if (!entitled) {
      this.options.onRejected?.('entitlement');
      throw new MessagingError('MEDIA_ACCESS_DENIED', DENIED_MESSAGE);
    }
    try {
      const result = await this.options.ledger.readChunk(
        validated.value.reference,
        validated.value.offset,
        validated.value.limit,
      );
      if (result === undefined) {
        this.options.onRejected?.('entitlement');
        throw new MessagingError('MEDIA_ACCESS_DENIED', DENIED_MESSAGE);
      }
      return result;
    } catch (error) {
      if (error instanceof RangeError) {
        this.options.onRejected?.('range');
        throw new MessagingError('VALIDATION', 'media.read offset is out of range');
      }
      if (error instanceof MessagingError) throw error;
      // Unknown/corrupt/missing backing bytes must not disclose whether a guessed hmr exists.
      this.options.onRejected?.('entitlement');
      throw new MessagingError('MEDIA_ACCESS_DENIED', DENIED_MESSAGE);
    }
  }
}

export function createPluginMediaHost(service: PluginMediaReadService, context: MediaReadContext): PluginMediaHost {
  return { read: (input) => service.read(context, input) };
}

export function createUnavailablePluginMediaHost(effectiveGrants: readonly string[]): PluginMediaHost {
  return {
    async read() {
      throw effectiveGrants.includes('media.read')
        ? new MessagingError('MEDIA_ACCESS_DENIED', DENIED_MESSAGE)
        : new MessagingError('PERMISSION', 'media.read capability is not granted');
    },
  };
}
