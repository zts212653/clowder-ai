import type { BrokerReadyParams, CandidateHello, SessionBinding, WireMethodName } from '@clowder-ai/plugin-contract';

export interface BrokerConnectionController {
  hello(connectionId: string, candidate: unknown): Promise<SessionBinding>;
  ready(connectionId: string, params: unknown): Promise<null>;
  call(connectionId: string, method: WireMethodName, input: unknown): Promise<unknown>;
  renewRuntimeLease(connectionId: string): Promise<number>;
  close(connectionId: string, reason?: string): Promise<void>;
}

export interface BrokerConnection {
  readonly connectionId: string;
  hello(candidate: CandidateHello | unknown): Promise<SessionBinding>;
  ready(params: BrokerReadyParams | unknown): Promise<null>;
  call(method: WireMethodName, input: unknown): Promise<unknown>;
  renewRuntimeLease(): Promise<number>;
  close(reason?: string): Promise<void>;
}

export type BuiltinBrokerConnectionController = BrokerConnectionController;
export type BuiltinBrokerConnection = BrokerConnection;

export function createBrokerConnection(controller: BrokerConnectionController, connectionId: string): BrokerConnection {
  return {
    connectionId,
    hello: (candidate) => controller.hello(connectionId, candidate),
    ready: (params) => controller.ready(connectionId, params),
    call: (method, input) => controller.call(connectionId, method, input),
    renewRuntimeLease: () => controller.renewRuntimeLease(connectionId),
    close: (reason) => controller.close(connectionId, reason),
  };
}

export const createBuiltinBrokerConnection = createBrokerConnection;
