import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryEntities } from '../MemoryEntities';
import { MemoryPersonDetail } from '../MemoryPersonDetail';
import { MemoryProfile } from '../MemoryProfile';

const { apiFetch, teleport } = vi.hoisted(() => ({ apiFetch: vi.fn(), teleport: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useTeleport', () => ({ handleTeleportEvent: teleport }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => ({ nickname: '砚砚' }) }) }));
const revision = `sha256:${'a'.repeat(64)}`;
const common = {
  proposalId: 'proposal-a',
  status: 'pending',
  sourceCatId: 'codex61-sol',
  sourceThreadId: 'source-thread',
  createdAt: 100,
  approvalState: 'anchored',
  approvalCardRef: { threadId: 'approval-thread', messageId: 'approval-card' },
};
const profileProposal = {
  ...common,
  expectedRevision: revision,
  suggestedContent: '建议先给实物。',
  rationale: '后来有了新情况。',
  decisionEndpointBase: '/api/profile-updates',
};
const entityProposal = {
  ...common,
  rationale: '用更准确的名字。',
  suggestedPatch: {
    entityType: 'concept',
    canonicalName: '新的名字',
    aliases: ['新别名'],
    stance: 'neutral',
    visibilityScope: 'workspace',
  },
  decisionEndpointBase: '/api/entity-proposals',
};
const personProposal = {
  ...common,
  status: 'pending_approval',
  displayName: '小林的新提案',
  remainingDraftIds: ['draft-a'],
  decisionEndpointBase: '/api/person-memory-proposals',
};
const profile = {
  id: 'corpus',
  type: 'profile',
  layer: 'corpus',
  relationshipKey: null,
  uri: 'cat-cafe-profile://corpus/current',
  title: '共同画像',
  content: '当前共同画像。',
  status: 'active',
  revision,
  proposals: [profileProposal],
};
const entity = {
  id: 'entity-a',
  type: 'entity',
  entityType: 'concept',
  canonicalName: '当前名字',
  aliases: [],
  stance: 'neutral',
  visibilityScope: 'workspace',
  updatedAt: '2026-10-06',
  provenanceCount: 0,
  provenance: [],
  status: 'active',
  revision,
  proposals: [entityProposal],
};
const person = {
  personId: 'person-a',
  displayName: '当前小林',
  aliases: [],
  status: 'active',
  createdAt: 100,
  updatedAt: 100,
  personRevision: 'person-revision-1',
  sourceCount: 0,
  claims: [],
  interactions: [],
  relationships: [],
  truncation: { claims: false, interactions: false, relationships: false, proposals: false },
  proposals: [personProposal],
};
type Family = 'profile' | 'entity' | 'person';
let host: HTMLDivElement;
let root: Root;
const button = (name: string) => [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === name);
async function click(name: string) {
  expect(button(name), name).toBeDefined();
  await act(async () => button(name)?.click());
}
async function render(family: Family, data: unknown) {
  apiFetch.mockImplementation(async (path: string) => {
    const body = path.includes('/source?')
      ? { status: 'ready', sources: [] }
      : path === '/api/memory/profile'
        ? { readStatus: 'ready', entries: [profile] }
        : path === '/api/memory/entities'
          ? { readStatus: 'ready', entries: [entity] }
          : data;
    return { ok: true, status: 200, json: async () => body };
  });
  await act(async () =>
    root.render(
      family === 'profile' ? (
        <MemoryProfile onReadSummary={vi.fn()} />
      ) : family === 'entity' ? (
        <MemoryEntities onReadSummary={vi.fn()} />
      ) : (
        <MemoryPersonDetail personId="person-a" close={vi.fn()} changed={vi.fn()} />
      ),
    ),
  );
  if (family !== 'person') await click(family === 'profile' ? '共同画像' : '当前名字');
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ['profile', profile, '当前共同画像。', '建议先给实物。'],
  ['entity', entity, '当前名字', '新的名字'],
  ['person', person, '当前小林', '小林的新提案'],
] as const)('attaches %s proposals to the current memory and opens only its exact original approval card', async (family, data, current, suggested) => {
  await render(family, data);
  expect(host.textContent).toContain(current);
  expect(host.textContent).toContain(suggested);
  expect(host.textContent).toContain('砚砚');
  await click('查看并决定');
  expect(teleport.mock.calls[0][0]).toEqual(common.approvalCardRef);
  expect(apiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('does not invent an approval destination for an unanchored Profile proposal', async () => {
  await render('profile', {
    ...profile,
    proposals: [{ ...profileProposal, approvalState: 'staged', approvalCardRef: undefined }],
  });
  expect(host.textContent).toContain('当前共同画像。');
  expect(host.textContent).toContain('建议先给实物。');
  expect(button('查看并决定')).toBeUndefined();
  expect(teleport).not.toHaveBeenCalled();
});

it.each([
  ['profile', profile, profileProposal],
  ['entity', entity, entityProposal],
  ['person', person, personProposal],
] as const)('rejects a malformed %s proposal locator instead of presenting an empty proposal list', async (family, data, proposal) => {
  await render(family, { ...data, proposals: [{ ...proposal, decisionEndpointBase: '/api/foreign-actions' }] });
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(button('查看并决定')).toBeUndefined();
  expect(teleport).not.toHaveBeenCalled();
});

it('keeps a legacy Profile readable while making its absent proposal projection honest', async () => {
  await render('profile', { ...profile, proposals: undefined });
  expect(host.textContent).toContain('当前共同画像。');
  expect(host.textContent).toContain('一时读不到这条记忆的提案');
  expect(button('查看并决定')).toBeUndefined();
});

it('keeps legacy Profile card metadata inert until the original authority anchors it', async () => {
  await render('profile', {
    ...profile,
    proposals: [{ ...profileProposal, approvalState: 'legacy_unanchored' }],
  });
  expect(host.textContent).toContain('建议先给实物。');
  expect(button('查看并决定')).toBeUndefined();
  expect(teleport).not.toHaveBeenCalled();
});

it('opens a settled Person proposal as its original approval history, without a fresh decision', async () => {
  await render('person', { ...person, proposals: [{ ...personProposal, status: 'materialized' }] });
  expect(button('查看并决定')).toBeUndefined();
  await click('查看审批记录');
  expect(teleport.mock.calls[0][0]).toEqual(common.approvalCardRef);
  expect(apiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
