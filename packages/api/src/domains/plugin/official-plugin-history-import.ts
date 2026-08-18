import type { EventsPublishInput, EventsPublishResult } from '@clowder-ai/plugin-contract';
import type { HostBrokerControlPlane } from './host-broker/control-plane.js';
import type { PluginInventoryStore } from './host-inventory/ports.js';
import type { PluginInstanceRecord } from './host-inventory/types.js';
import type { OfficialPluginCatalogEntry } from './official-catalog.js';

export type OfficialPluginHistoryImportErrorCode =
  | 'INVALID_REFERENCE'
  | 'STALE_REVISION'
  | 'INSTANCE_NOT_READY'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_UNAVAILABLE';

export class OfficialPluginHistoryImportError extends Error {
  constructor(
    readonly code: OfficialPluginHistoryImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OfficialPluginHistoryImportError';
  }
}

export interface OfficialPluginHistoryImportInput {
  readonly entry: OfficialPluginCatalogEntry;
  readonly instance: PluginInstanceRecord;
  readonly expectedRevision: number;
  readonly reference: string;
}

export interface OfficialPluginHistoryImportPort {
  importMinute(input: OfficialPluginHistoryImportInput): Promise<EventsPublishResult>;
}

interface FeishuArtifactLocator {
  readonly artifactId: string;
  readonly kind: 'minute';
  readonly revision?: string;
}

export interface OfficialPluginHistoryImportServiceOptions {
  readonly inventory: PluginInventoryStore;
  readonly broker: Pick<HostBrokerControlPlane, 'publishOwnerImportedSignal'>;
  readonly parseReference: (reference: string) => FeishuArtifactLocator;
  readonly inspectArtifact: (locator: FeishuArtifactLocator, signal: AbortSignal) => Promise<unknown>;
  readonly normalizeArtifact: (descriptor: unknown) => EventsPublishInput;
  readonly timeoutMs?: number;
}

function errorCode(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
    ? value.code
    : undefined;
}

export class OfficialPluginHistoryImportService implements OfficialPluginHistoryImportPort {
  private readonly timeoutMs: number;

  constructor(private readonly options: OfficialPluginHistoryImportServiceOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new TypeError('historical import timeout must be 1..60000ms');
    }
  }

  async importMinute(input: OfficialPluginHistoryImportInput): Promise<EventsPublishResult> {
    await this.assertCurrentAuthority(input);
    let locator: FeishuArtifactLocator;
    try {
      locator = this.options.parseReference(input.reference);
    } catch {
      throw new OfficialPluginHistoryImportError('INVALID_REFERENCE', 'Use one Feishu Minutes URL or Minute token');
    }

    let descriptor: unknown;
    try {
      descriptor = await this.options.inspectArtifact(locator, AbortSignal.timeout(this.timeoutMs));
    } catch (error) {
      if (errorCode(error) === 'NOT_FOUND') {
        throw new OfficialPluginHistoryImportError('SOURCE_NOT_FOUND', 'The Feishu Minute is not available');
      }
      throw new OfficialPluginHistoryImportError(
        'SOURCE_UNAVAILABLE',
        'Feishu could not return this historical Minute',
      );
    }

    let signal: EventsPublishInput;
    try {
      signal = this.options.normalizeArtifact(descriptor);
    } catch {
      throw new OfficialPluginHistoryImportError(
        'SOURCE_UNAVAILABLE',
        'Feishu returned an invalid historical Minute descriptor',
      );
    }
    await this.assertCurrentAuthority(input);
    try {
      return await this.options.broker.publishOwnerImportedSignal(input.instance.pluginInstanceId, signal);
    } catch (error) {
      if (
        [
          'SESSION_NOT_ACTIVE',
          'SESSION_NOT_FOUND',
          'INSTANCE_NOT_READY',
          'AUTHORITY_CHANGED',
          'METHOD_NOT_READY',
        ].includes(errorCode(error) ?? '')
      ) {
        throw new OfficialPluginHistoryImportError(
          'INSTANCE_NOT_READY',
          'The official plugin runtime changed before historical import completed',
        );
      }
      throw new OfficialPluginHistoryImportError(
        'SOURCE_UNAVAILABLE',
        'The historical Minute could not enter the meeting intake',
      );
    }
  }

  private async assertCurrentAuthority(input: OfficialPluginHistoryImportInput): Promise<void> {
    const snapshot = await this.options.inventory.snapshot();
    const instance = snapshot.instances.find(
      (candidate) => candidate.pluginInstanceId === input.instance.pluginInstanceId,
    );
    if (instance && instance.lifecycleRevision !== input.expectedRevision) {
      throw new OfficialPluginHistoryImportError('STALE_REVISION', 'Official plugin state changed');
    }
    const current = snapshot.instances.find(
      (candidate) => candidate.pluginId === input.entry.pluginId && candidate.lifecycleState === 'installed',
    );
    const packageRecord = snapshot.packages.find(
      (candidate) => candidate.packageDigest === instance?.packageDigest && candidate.packageState === 'installed',
    );
    if (
      !instance ||
      current?.pluginInstanceId !== instance.pluginInstanceId ||
      instance.pluginId !== input.entry.pluginId ||
      instance.packageDigest !== input.entry.packageDigest ||
      packageRecord?.version !== input.entry.version ||
      instance.lifecycleState !== 'installed' ||
      instance.configReadiness !== 'ready' ||
      instance.activationState !== 'enabled' ||
      instance.runtimeState !== 'healthy'
    ) {
      throw new OfficialPluginHistoryImportError(
        'INSTANCE_NOT_READY',
        'Historical import requires the current healthy official plugin runtime',
      );
    }
  }
}
