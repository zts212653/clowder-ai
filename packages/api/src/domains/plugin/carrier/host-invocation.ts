import type { M0CDeliverInput, M0CDeliverResult } from '@clowder-ai/plugin-contract';

/** The Host's one carrier-neutral way to invoke an action exposed by an active plugin. */
export interface HostPluginInvocationPort {
  invoke(targetId: string, method: string, params: unknown): Promise<unknown>;
  deliver(targetId: string, input: M0CDeliverInput): Promise<M0CDeliverResult>;
}

/** The published Host→plugin messaging row, independent of its runtime carrier. */
export type HostMessagingDeliveryPort = Pick<HostPluginInvocationPort, 'deliver'>;
