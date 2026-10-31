import type { PreviewVisiblePageAdmission, PreviewVisiblePageAttestation } from '@cat-cafe/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPreviewVisiblePageAdmissionController } from '../preview-visible-page-admission-controller';

const admission: PreviewVisiblePageAdmission = {
  expectedClientRevision: 'b'.repeat(40),
  requiredDom: [{ selector: '[data-layout-owner="f307"]' }],
};
const WORKBENCH_SELECTOR = '[data-layout-owner="f307"]';

function makeRequest(eventId: string) {
  return {
    eventId,
    port: 3011,
    path: '/threads/thread-f307?workspaceView=surface',
    targetOrigin: 'http://preview-3011.localhost:4111',
    admission,
  };
}

function makeAttestation(eventId: string): PreviewVisiblePageAttestation {
  return {
    eventId,
    targetPort: 3011,
    targetOrigin: 'http://preview-3011.localhost:4111',
    targetPath: '/threads/thread-f307?workspaceView=surface',
    clientRevision: 'b'.repeat(40),
    dom: [{ selector: WORKBENCH_SELECTOR, found: true, attributes: {}, textMatches: [] }],
    forbiddenTextMatches: [],
  };
}

describe('PreviewVisiblePageAdmissionController', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps delivery pending until the exact visible iframe attests', async () => {
    const controller = createPreviewVisiblePageAdmissionController();
    const result = controller.begin(makeRequest('evt-1'));

    expect(controller.getSnapshot()).toEqual(makeRequest('evt-1'));
    controller.attest(makeAttestation('evt-other'));
    expect(controller.getSnapshot()).toEqual(makeRequest('evt-1'));

    controller.attest(makeAttestation('evt-1'));
    await expect(result).resolves.toEqual({ status: 'attested', attestation: makeAttestation('evt-1') });
    expect(controller.getSnapshot()).toBeNull();
  });

  it('fails loudly when the target never attests', async () => {
    vi.useFakeTimers();
    const controller = createPreviewVisiblePageAdmissionController({ timeoutMs: 8_000 });
    const result = controller.begin(makeRequest('evt-timeout'));

    await vi.advanceTimersByTimeAsync(8_000);
    await expect(result).resolves.toEqual({ status: 'failed', reason: 'visible_page_timeout' });
    expect(controller.getSnapshot()).toBeNull();
  });

  it('supersedes an older unproven request instead of misbinding its proof', async () => {
    const controller = createPreviewVisiblePageAdmissionController();
    const first = controller.begin(makeRequest('evt-old'));
    const second = controller.begin(makeRequest('evt-new'));

    await expect(first).resolves.toEqual({ status: 'failed', reason: 'visible_page_superseded' });
    controller.attest(makeAttestation('evt-new'));
    await expect(second).resolves.toEqual({ status: 'attested', attestation: makeAttestation('evt-new') });
  });
});
