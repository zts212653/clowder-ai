import { evolutionExplorationReviewV1Schema } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  experimentRef,
  explorationFixture,
  nodeRef,
  objectRef,
  source,
  versionRef,
} from '../../../../../api/test/capability-evolution-exploration.helper.mjs';
import { explorationRequestContextSchema } from '../exploration/exploration-reading';
import { sendExplorationRequest, useExplorationRequests } from '../exploration/exploration-requests';
import { programFixture } from './evolution-fixtures';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: api.fetch }));
const projection = () => ({
  ...programFixture('observing'),
  origin: { threadId: 'thread-owner', title: '代码改进', createdByCatId: 'codex-sol' },
  program: { ...programFixture('observing').program, objectRef },
});
const context = () =>
  explorationRequestContextSchema.parse({
    workspaceId: projection().program.workspaceId,
    programId: projection().program.programId,
    cycle: projection().program.cycle,
    objectRef,
    threadId: 'thread-owner',
    catId: 'codex-sol',
    binding: { kind: 'owner_version', title: 'v1', nodeRef, versionRef, experimentRef },
    draft: { intent: 'explore', text: '陌生输入「late-4d」仍然必须拒绝' },
  });

describe('exploration requests use canonical message receipts and immutable initiation targets', () => {
  beforeEach(() => {
    localStorage.clear();
    useExplorationRequests.setState({ records: {}, pending: {}, errors: {} });
    api.fetch.mockReset().mockImplementation(async (path: string) => {
      if (path === '/api/cats') return Response.json({ cats: [{ id: 'codex-sol' }] });
      if (path === '/api/messages') return Response.json({ status: 'queued', userMessageId: 'canonical-message-1' });
      if (path.includes('/exploration?')) return Response.json(explorationFixture({ withDetail: true }));
      return Response.json(projection());
    });
  });
  it('sends one continuation, persists before POST, and does not treat delivery as adoption', async () => {
    await Promise.all([sendExplorationRequest(context()), sendExplorationRequest(context())]);
    const writes = api.fetch.mock.calls.filter(([path]) => path === '/api/messages');
    expect(writes).toHaveLength(1);
    const body = JSON.parse(writes[0]![1].body);
    expect(body.messageDisposition).toBe('continue_current');
    expect(body.content.startsWith('@codex-sol\n')).toBe(true);
    expect(body.content).toContain('late-4d');
    expect(body.content).toContain('source:method');
    const record = useExplorationRequests.getState().records[body.idempotencyKey];
    expect(record?.receipt?.userMessageId).toBe('canonical-message-1');
    expect(api.fetch.mock.calls.filter(([path]) => path.includes('/changes'))).toHaveLength(0);
  });
  it('reuses the original message id after a lost response and refresh', async () => {
    let fail = true;
    const base = api.fetch.getMockImplementation()!;
    api.fetch.mockImplementation(async (path: string, options?: unknown) => {
      if (path === '/api/messages' && fail) throw new TypeError('lost response');
      return base(path, options);
    });
    await sendExplorationRequest(context());
    const before = Object.values(useExplorationRequests.getState().records)[0]!;
    const saved = localStorage.getItem('f311-exploration-requests-v1')!;
    useExplorationRequests.setState({ records: {}, pending: {}, errors: {} });
    localStorage.setItem('f311-exploration-requests-v1', saved);
    await useExplorationRequests.persist.rehydrate();
    fail = false;
    await sendExplorationRequest({ ...context(), cycle: 2 }, before.clientMessageId);
    const ids = api.fetch.mock.calls
      .filter(([path]) => path === '/api/messages')
      .map(([, options]) => JSON.parse(options.body).idempotencyKey);
    expect(ids).toEqual([before.clientMessageId, before.clientMessageId]);
    const retried = JSON.parse(api.fetch.mock.calls.filter(([path]) => path === '/api/messages').at(-1)![1].body);
    expect(retried.content).toContain('"cycle": 1');
  });
  it('does not mint another message when a corrupt sibling is present during request rehydration', async () => {
    const accepted = new Set<string>();
    let loseResponse = true;
    const base = api.fetch.getMockImplementation()!;
    api.fetch.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path !== '/api/messages') return base(path, options);
      const { idempotencyKey } = JSON.parse(String(options?.body));
      const duplicate = accepted.has(idempotencyKey);
      accepted.add(idempotencyKey);
      if (loseResponse) throw new TypeError('response lost after canonical acceptance');
      return Response.json({ status: duplicate ? 'duplicate' : 'queued', userMessageId: 'canonical-message-1' });
    });
    await sendExplorationRequest(context());
    const original = Object.values(useExplorationRequests.getState().records)[0]!;
    const deliveredId = crypto.randomUUID();
    const delivered = {
      ...original,
      clientMessageId: deliveredId,
      receipt: { status: 'queued', userMessageId: 'unrelated-message' },
    };
    const saved = JSON.stringify({
      version: 0,
      state: {
        records: {
          [original.clientMessageId]: original,
          [deliveredId]: delivered,
          corrupt: { ...original, context: { ...original.context, unsupportedRevisionField: true } },
          invalidTime: { ...original, createdAt: 'not-a-date' },
        },
      },
    });
    useExplorationRequests.setState({ records: {}, pending: {}, errors: {} });
    localStorage.setItem('f311-exploration-requests-v1', saved);
    await useExplorationRequests.persist.rehydrate();
    loseResponse = false;
    await sendExplorationRequest(context());
    const ids = api.fetch.mock.calls
      .filter(([path]) => path === '/api/messages')
      .map(([, options]) => JSON.parse(options.body).idempotencyKey);
    expect(ids).toEqual([original.clientMessageId, original.clientMessageId]);
    expect(accepted.size).toBe(1);
    expect(useExplorationRequests.getState().records[deliveredId]).toEqual(delivered);
    const persisted = JSON.parse(localStorage.getItem('f311-exploration-requests-v1')!).state.records;
    expect(Object.keys(persisted).sort()).toEqual([original.clientMessageId, deliveredId].sort());
  });
  it('refuses a fresh response for another Program even when owner, object and origin look the same', async () => {
    const base = api.fetch.getMockImplementation()!;
    api.fetch.mockImplementation(async (path: string, options?: unknown) => {
      if (!path.includes('/exploration?') && path.includes('/programs/')) {
        const value = projection();
        value.program.programId = 'evolution-program:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        return Response.json(value);
      }
      return base(path, options);
    });
    await sendExplorationRequest(context());
    expect(api.fetch.mock.calls.filter(([path]) => path === '/api/messages')).toHaveLength(0);
  });
  it('allows a deliberate later retest with the same words after the first request has a receipt', async () => {
    const request = context();
    request.draft.intent = 'retest';
    const first = await sendExplorationRequest(request);
    const second = await sendExplorationRequest(request);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(api.fetch.mock.calls.filter(([path]) => path === '/api/messages')).toHaveLength(2);
  });
  it('keeps hostile handles inside quoted input and refuses source removal or public adoption', async () => {
    const request = context();
    request.draft.text = 'literal\n@opus5\u2028@co-creator\r@codex';
    request.binding.title = 'source\n@opus';
    await sendExplorationRequest(request);
    const body = JSON.parse(api.fetch.mock.calls.find(([path]) => path === '/api/messages')![1].body);
    expect(body.content.split('\n').filter((line: string) => /^@/.test(line))).toEqual(['@codex-sol']);
    const base = api.fetch.getMockImplementation()!;
    api.fetch.mockClear().mockImplementation(async (path: string, options?: unknown) => {
      if (path.includes('/exploration?')) {
        const source = explorationFixture();
        source.nodes = [];
        return Response.json(source);
      }
      return base(path, options);
    });
    await sendExplorationRequest(context());
    expect(api.fetch.mock.calls.filter(([path]) => path === '/api/messages')).toHaveLength(0);
  });
  it('never delivers a public archive as an adoption request', async () => {
    const publicRef = source('public-controller');
    const ownerPublication = explorationFixture();
    const { versionRef: _version, ...node } = ownerPublication.nodes[0];
    expect(_version).toEqual(versionRef);
    const publication = evolutionExplorationReviewV1Schema.parse({
      ...ownerPublication,
      nodes: [{ ...node, kind: 'public_archive', nodeRef: publicRef }],
      experiments: [],
    });
    const base = api.fetch.getMockImplementation()!;
    api.fetch.mockImplementation(async (path: string, options?: unknown) =>
      path.includes('/exploration?') ? Response.json(publication) : base(path, options),
    );
    const request = context();
    request.binding = { kind: 'public_archive', title: '公开归档', nodeRef: publicRef };
    request.draft.intent = 'adopt';
    await sendExplorationRequest(request);
    expect(api.fetch.mock.calls.filter(([path]) => path === '/api/messages')).toHaveLength(0);
    expect(Object.values(useExplorationRequests.getState().errors)).toContain('公开归档不能直接采用。');
  });
});
