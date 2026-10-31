// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { SharedArtifact } from '../collective-artifact-client.js';
import { SharedArtifactManagement } from '../SharedArtifactManagement.js';
import { CollectiveArtifactContext, type CollectiveArtifactState } from '../use-collective-artifacts.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
it('distinguishes same-name Humans and Cafes, sends the selected exact Cafe and disables a destination removed by a fresh directory', async () => {
  const artifact = {
    serviceInstanceId: 'service',
    collectiveId: 'collective',
    artifactId: 'artifact',
    accessRevision: 1,
  } as SharedArtifact;
  const offer = vi.fn(async () => {});
  const read = vi.fn(async () => {});
  const cafes = [
    { connectionId: 'first-cafe', endpointId: 'first', endpointLabel: 'Café', humanId: 'human-one' },
    { connectionId: 'second-cafe', endpointId: 'second', endpointLabel: 'Café', humanId: 'human-one' },
    { connectionId: 'third-cafe', endpointId: 'third', endpointLabel: 'Café', humanId: 'human-two' },
    { connectionId: 'source-cafe', endpointId: 'source', endpointLabel: 'Source', humanId: 'manager' },
  ];
  const members = ['human-one', 'human-two'].map((humanId) => ({
    humanId,
    displayName: '同名成员',
    access: 'read',
    accessRevision: 1,
    canReceiveCustody: true,
  }));
  const state = {
    status: 'ready',
    humanId: 'manager',
    members: { humans: members, cafes },
    humanName: () => '同名成员',
    refresh: async () => {},
    api: {
      read,
      management: {
        offer,
        hasPending: () => false,
        read: async () => ({
          canManageAccess: true,
          canManageCustody: true,
          custodyRevision: 1,
          custodyAvailable: true,
          custodianHumanId: 'manager',
          custodianCafe: { connectionId: 'source-cafe', endpointLabel: 'Source' },
          snapshot: 'cut',
          total: members.length,
          offset: 0,
          members,
        }),
      },
    },
  } as unknown as CollectiveArtifactState;
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = (value: CollectiveArtifactState) =>
    root.render(
      <CollectiveArtifactContext.Provider value={value}>
        <SharedArtifactManagement artifact={artifact} />
      </CollectiveArtifactContext.Provider>,
    );
  try {
    await act(async () => render(state));
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="作品接收 Café"]');
    expect(select).not.toBeNull();
    const options = Array.from(select?.options ?? []).filter((option) => option.value);
    expect(options.map((option) => option.value)).toEqual(['first-cafe', 'second-cafe', 'third-cafe']);
    expect(new Set(options.map((option) => option.textContent)).size).toBe(3);
    expect(options.every((option) => option.textContent?.includes('Café'))).toBe(true);
    const policyNames = Array.from(host.querySelectorAll('select'))
      .filter((item) => item !== select)
      .map((item) => item.getAttribute('aria-label'));
    expect(new Set(policyNames).size).toBe(2);
    expect(policyNames.every((label) => label?.includes('human-'))).toBe(true);
    await act(async () => {
      if (!select) throw new Error('Destination missing');
      select.value = 'second-cafe';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(offer).not.toHaveBeenCalled();
    const submit = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === '交接作品与记录',
    );
    await act(async () => submit?.click());
    expect(read).toHaveBeenCalledWith(artifact);
    expect(offer).toHaveBeenCalledWith(artifact, 'human-one', 1, 'second-cafe');
    await act(async () =>
      render({
        ...state,
        members: { ...state.members, cafes: cafes.filter((cafe) => cafe.connectionId !== 'second-cafe') },
      } as CollectiveArtifactState),
    );
    expect(submit?.disabled).toBe(true);
    expect(offer).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});
