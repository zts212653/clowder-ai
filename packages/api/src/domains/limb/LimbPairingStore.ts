/**
 * LimbPairingStore — F126 Phase C 设备配对审批
 *
 * 远程节点注册后进入 pending 状态，需要铲屎官审批后才能接入。
 * 审批通过 → 生成 RemoteLimbNode → 注册到 LimbRegistry。
 */

import { randomUUID } from 'node:crypto';
import type { LimbCapability } from '@cat-cafe/shared';

export interface PairingRequest {
  requestId: string;
  nodeId: string;
  displayName: string;
  platform: string;
  endpointUrl: string;
  capabilities: LimbCapability[];
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  decidedAt?: number;
  /** Generated token for the remote node to authenticate heartbeats/deregister */
  apiKey: string;
}

export interface CreatePairingParams {
  nodeId: string;
  displayName: string;
  platform: string;
  endpointUrl: string;
  capabilities: LimbCapability[];
}

export class LimbPairingStore {
  private readonly requests = new Map<string, PairingRequest>();

  createRequest(params: CreatePairingParams): PairingRequest {
    // Check for duplicate nodeId in pending/approved
    for (const req of this.requests.values()) {
      if (req.nodeId === params.nodeId && req.status !== 'rejected') {
        return req; // Idempotent: return existing
      }
    }

    const request: PairingRequest = {
      requestId: randomUUID(),
      ...params,
      status: 'pending',
      createdAt: Date.now(),
      apiKey: randomUUID(),
    };

    this.requests.set(request.requestId, request);
    return request;
  }

  approve(requestId: string): PairingRequest | null {
    const req = this.requests.get(requestId);
    if (!req) return null;
    if (req.status === 'approved') return req; // Idempotent
    req.status = 'approved';
    req.decidedAt = Date.now();
    return req;
  }

  reject(requestId: string): boolean {
    const req = this.requests.get(requestId);
    if (!req) return false;
    req.status = 'rejected';
    req.decidedAt = Date.now();
    return true;
  }

  getPending(): PairingRequest[] {
    return [...this.requests.values()].filter((r) => r.status === 'pending');
  }

  getApproved(): PairingRequest[] {
    return [...this.requests.values()].filter((r) => r.status === 'approved');
  }

  findByApiKey(apiKey: string): PairingRequest | undefined {
    return [...this.requests.values()].find((r) => r.apiKey === apiKey && r.status === 'approved');
  }

  get(requestId: string): PairingRequest | undefined {
    return this.requests.get(requestId);
  }
}
