import type { PackageAdmissionCandidate } from '../host-inventory/types.js';
export type StateDomain = 'inventory' | 'broker';
export type StateEntity = 'package' | 'instance' | 'session' | 'lease' | 'call' | 'epoch' | 'preference' | 'feature';
export type StateIndex = 'key' | 'pluginId' | 'instanceId' | 'sessionId' | 'packageDigest' | 'phase';
export interface StateQuery {
  readonly entity: StateEntity;
  readonly index?: StateIndex;
  readonly value?: string;
  readonly phase?: string;
  readonly phases?: readonly string[];
  readonly afterRowid?: number;
  readonly limit?: number;
}
export type StateOperation =
  | { readonly op: 'hasRecords'; readonly domain: StateDomain }
  | {
      readonly op: 'activation';
      readonly domain: 'broker';
      readonly instanceId: string;
      readonly featureId: string;
      readonly sessionId: string;
      readonly transaction?: string;
    }
  | {
      readonly op: 'verifyAdmission';
      readonly domain: 'inventory';
      readonly candidate: PackageAdmissionCandidate;
      readonly now: number;
    }
  | { readonly op: 'outcome'; readonly domain: StateDomain; readonly path: string; readonly transaction: string }
  | { readonly op: 'open'; readonly domain: StateDomain; readonly path: string }
  | {
      readonly op: 'begin' | 'commit' | 'rollback';
      readonly domain: StateDomain;
      readonly transaction: string;
      readonly acknowledgedTransaction?: string;
    }
  | {
      readonly op: 'get' | 'list';
      readonly domain: StateDomain;
      readonly query: StateQuery;
      readonly transaction?: string;
    }
  | {
      readonly op: 'put';
      readonly domain: StateDomain;
      readonly entity: StateEntity;
      readonly value: unknown;
      readonly transaction: string;
    }
  | { readonly op: 'authority'; readonly domain: 'inventory'; readonly instanceId: string; readonly byPlugin?: boolean }
  | { readonly op: 'connection'; readonly domain: 'broker'; readonly connectionId: string }
  | {
      readonly op: 'features';
      readonly domain: 'broker';
      readonly instanceId?: string;
      readonly activeOnly?: boolean;
      readonly transaction?: string;
    }
  | {
      readonly op: 'putFeatures';
      readonly updateOnly?: boolean;
      readonly domain: 'broker';
      readonly instanceId?: string;
      readonly value: unknown;
      readonly transaction: string;
    };
export interface StateRequest {
  readonly id: number;
  readonly operation: StateOperation;
}
export type StateResponse =
  | { readonly id: number; readonly value: unknown }
  | {
      readonly id: number;
      readonly error: { readonly name: string; readonly message: string; readonly code?: string };
    };
