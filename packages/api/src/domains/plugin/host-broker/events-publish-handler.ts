import type { SignalRuntimeBinding } from '@cat-cafe/shared';
import {
  type EventsPublishInput,
  type EventsPublishResult,
  validateEventsPublishInput,
  validateEventsPublishResult,
} from '@clowder-ai/plugin-contract';
import { digestCanonical } from '../../signal-intake/canonical-json.js';
import { SignalAdmissionError, type SignalAdmissionErrorCode } from '../../signal-intake/errors.js';
import type { SignalIngressTraceSink } from '../../signal-intake/IngressTrace.js';
import type { MeetingIntakeStore } from '../../signal-intake/MeetingIntakeStore.js';
import { SignalAdmissionService, signalSettlementKey } from '../../signal-intake/SignalAdmissionService.js';
import type { SignalRouteStore } from '../../signal-intake/SignalRouteStore.js';
import type { SignalRuntimeLeaseRecord, SignalRuntimeLeaseStore } from '../../signal-intake/SignalRuntimeLeaseStore.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { HostBrokerStore } from './ports.js';
import type { BrokerCallContext, BrokerCallError, BrokerMethodHandler, BrokerValidationResult } from './types.js';
import { HostBrokerError } from './types.js';

const SIGNAL_ADMISSION_ERROR_CODES = new Set<SignalAdmissionErrorCode>([
  'INVALID_SIGNAL',
  'AUTHORITY_MISMATCH',
  'PLUGIN_NOT_READY',
  'GRANT_MISSING',
  'STALE_GRANT',
  'RUNTIME_LEASE_MISSING',
  'RUNTIME_LEASE_EXPIRED',
  'ROUTE_UNAVAILABLE',
  'STALE_ROUTE',
  'IDEMPOTENCY_CONFLICT',
  'SOURCE_IDENTITY_CONFLICT',
]);

function isSignalAdmissionErrorCode(value: string): value is SignalAdmissionErrorCode {
  return SIGNAL_ADMISSION_ERROR_CODES.has(value as SignalAdmissionErrorCode);
}

export class HostBrokerSignalRuntimeLeaseStore implements SignalRuntimeLeaseStore {
  constructor(private readonly store: HostBrokerStore) {}

  async get(leaseId: string): Promise<SignalRuntimeLeaseRecord | null> {
    const lease = (await this.store.snapshot()).runtimeLeases.find((candidate) => candidate.runtimeLeaseId === leaseId);
    if (!lease) return null;
    return {
      leaseId: lease.runtimeLeaseId,
      sessionId: lease.brokerSessionId,
      pluginInstanceId: lease.pluginInstanceId,
      packageDigest: lease.packageDigest,
      grantRevision: lease.grantRevision,
      state: lease.state === 'pending' ? 'closed' : lease.state,
      expiresAt: lease.expiresAt,
    };
  }
}

export interface EventsPublishBrokerHandlerOptions {
  readonly inventory: PluginInventoryStore;
  readonly brokerStore: HostBrokerStore;
  readonly routes: SignalRouteStore;
  readonly intakes: MeetingIntakeStore;
  readonly now?: () => number;
  readonly createPublicationId?: () => string;
  readonly createIntakeId?: () => string;
  readonly traces?: SignalIngressTraceSink;
}

class EventsPublishBrokerHandler implements BrokerMethodHandler<EventsPublishInput, EventsPublishResult> {
  readonly method = 'events.publish' as const;
  private readonly admission: SignalAdmissionService;

  constructor(private readonly options: EventsPublishBrokerHandlerOptions) {
    this.admission = new SignalAdmissionService({
      inventory: options.inventory,
      runtimeLeases: new HostBrokerSignalRuntimeLeaseStore(options.brokerStore),
      routes: options.routes,
      intakes: options.intakes,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.createPublicationId === undefined ? {} : { createPublicationId: options.createPublicationId }),
      ...(options.createIntakeId === undefined ? {} : { createIntakeId: options.createIntakeId }),
      ...(options.traces === undefined ? {} : { traces: options.traces }),
    });
  }

  validateInput(value: unknown): BrokerValidationResult<EventsPublishInput> {
    const result = validateEventsPublishInput(value);
    return result.valid ? { valid: true, value: result.value } : { valid: false };
  }

  validateResult(value: unknown): value is EventsPublishResult {
    return validateEventsPublishResult(value).valid;
  }

  settlementKey(context: BrokerCallContext, input: EventsPublishInput): string {
    return signalSettlementKey(context.pluginInstanceId, input);
  }

  async dispatch(context: BrokerCallContext, input: EventsPublishInput): Promise<EventsPublishResult> {
    const route = await this.options.routes.get(context.pluginId, input.signalType);
    if (!route || route.state !== 'active') {
      throw new SignalAdmissionError('ROUTE_UNAVAILABLE', 'no active Host route admits this signal');
    }
    const binding: SignalRuntimeBinding = {
      pluginInstanceId: context.pluginInstanceId,
      packageDigest: context.packageDigest,
      sessionId: context.brokerSessionId,
      runtimeLeaseId: context.runtimeLeaseId,
      grantRevision: context.grantRevision,
      routeGeneration: route.generation,
    };
    return this.admission.publish(binding, input);
  }

  async lookupSettlement(context: BrokerCallContext, input: EventsPublishInput): Promise<EventsPublishResult | null> {
    const settlementKey = signalSettlementKey(context.pluginInstanceId, input);
    const settlement = await this.options.intakes.lookupSettlement(settlementKey);
    if (!settlement) return null;
    if (settlement.canonicalDigest !== digestCanonical(input)) {
      throw new SignalAdmissionError(
        'IDEMPOTENCY_CONFLICT',
        'recovered signal settlement does not match the current call input',
      );
    }
    return { publicationId: settlement.publicationId, disposition: 'duplicate' };
  }

  serializePreEffectError(error: unknown): BrokerCallError | null {
    if (!(error instanceof SignalAdmissionError)) return null;
    return { code: error.code, message: error.message };
  }

  canRetrySettledErrorAfterAuthorityChange(error: BrokerCallError): boolean {
    return error.code === 'ROUTE_UNAVAILABLE';
  }

  restoreSettledError(error: BrokerCallError): Error {
    if (!isSignalAdmissionErrorCode(error.code)) {
      return new HostBrokerError('BROKER_INVARIANT', `events.publish stored unsupported error ${error.code}`);
    }
    return new SignalAdmissionError(error.code, error.message);
  }
}

export function createEventsPublishBrokerHandler(
  options: EventsPublishBrokerHandlerOptions,
): BrokerMethodHandler<EventsPublishInput, EventsPublishResult> {
  return new EventsPublishBrokerHandler(options);
}
