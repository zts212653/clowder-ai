/**
 * F268 Sol R2 P1-3 — Sender status classification test.
 *
 * Tests the actual sender boundary with mocked fetch, proving:
 * - 401 → throws (triggers retry in queue)
 * - 409 → resolves (conflict, no retry)
 * - other 4xx → resolves (dead-letter)
 * - 5xx → throws (triggers retry)
 * - 202 → resolves with ack data
 *
 * Unlike the queue-level test which uses a fake sender that always throws,
 * this proves the real sender's response classification logic at the fetch boundary.
 */

import type { TipEventBatch } from '@cat-cafe/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
}));

// Mock the shared request client before importing the sender.
vi.mock('@/utils/api-client', () => ({
  apiFetch: apiFetchMock,
}));

// Mock queue to prevent auto-init side-effect
vi.mock('../capabilityTipQueue', () => ({
  getTipEventQueue: () => ({ setSender: () => {} }),
}));

import { createTipEventSender } from '../capabilityTipSender';

// ── Helpers ─────────────────────────────────────────────────────────────────

const validBatch: TipEventBatch = {
  batchId: '550e8400-e29b-41d4-a716-446655440000',
  attempt: 1,
  events: [
    {
      event: 'capability_tip_exposed',
      tipId: 'test-tip',
      context: 'thinking',
      surface: 'pending_bubble',
      outcome: 'shown',
      timestamp: 1721000000000,
    },
  ],
  assembledAt: 1721000005000,
  schemaVersion: 1,
};

function makeFetch(status: number, body?: object): typeof fetch {
  return vi.fn().mockResolvedValue({
    status,
    json: () => Promise.resolve(body ?? {}),
  }) as unknown as typeof fetch;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('F268 createTipEventSender — status classification (Sol R2 P1-3)', () => {
  afterEach(() => {
    apiFetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('uses the shared session-refreshing API client by default', async () => {
    const rawFetch = makeFetch(202, { batchId: validBatch.batchId, accepted: 1, rejected: 0 });
    vi.stubGlobal('fetch', rawFetch);
    apiFetchMock.mockResolvedValue({
      status: 202,
      json: () => Promise.resolve({ batchId: validBatch.batchId, accepted: 1, rejected: 0 }),
    });

    const sender = createTipEventSender();
    await sender(validBatch);

    expect(apiFetchMock).toHaveBeenCalledWith('/api/tip-telemetry/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBatch),
    });
    expect(rawFetch).not.toHaveBeenCalled();
  });

  it('202 → resolves with accepted/rejected from ack', async () => {
    const mockFetch = makeFetch(202, { batchId: validBatch.batchId, accepted: 1, rejected: 0 });
    const sender = createTipEventSender(mockFetch);

    const result = await sender(validBatch);
    expect(result).toEqual({ accepted: 1, rejected: 0 });
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('401 → throws (triggers retry via queue backoff)', async () => {
    const mockFetch = makeFetch(401);
    const sender = createTipEventSender(mockFetch);

    await expect(sender(validBatch)).rejects.toThrow('auth not ready');
  });

  it('409 → resolves with 0 accepted (conflict, no retry)', async () => {
    const mockFetch = makeFetch(409, { batchId: validBatch.batchId, accepted: 0, rejected: 1 });
    const sender = createTipEventSender(mockFetch);

    const result = await sender(validBatch);
    expect(result).toEqual({ accepted: 0, rejected: 1 });
  });

  it('400 (other 4xx) → resolves (dead-letter, no retry)', async () => {
    const mockFetch = makeFetch(400);
    const sender = createTipEventSender(mockFetch);

    const result = await sender(validBatch);
    expect(result).toEqual({ accepted: 0, rejected: validBatch.events.length });
  });

  it('422 (other 4xx) → resolves (dead-letter, no retry)', async () => {
    const mockFetch = makeFetch(422);
    const sender = createTipEventSender(mockFetch);

    const result = await sender(validBatch);
    expect(result).toEqual({ accepted: 0, rejected: validBatch.events.length });
  });

  it('500 → throws (triggers retry via queue backoff)', async () => {
    const mockFetch = makeFetch(500);
    const sender = createTipEventSender(mockFetch);

    await expect(sender(validBatch)).rejects.toThrow('upload failed');
  });

  it('503 → throws (triggers retry via queue backoff)', async () => {
    const mockFetch = makeFetch(503);
    const sender = createTipEventSender(mockFetch);

    await expect(sender(validBatch)).rejects.toThrow('upload failed');
  });

  it('sends the batch through the shared request client', async () => {
    const mockFetch = makeFetch(202, { batchId: validBatch.batchId, accepted: 1, rejected: 0 });
    const sender = createTipEventSender(mockFetch);

    await sender(validBatch);

    expect(mockFetch).toHaveBeenCalledWith('/api/tip-telemetry/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBatch),
    });
  });
});
