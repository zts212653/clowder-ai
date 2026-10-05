import { describe, expect, it } from 'vitest';
import { executeHostWorkPolicyCommand } from '../host-work-policy-command.js';

const coordinates = { serviceInstanceId: 'svc_12345678', collectiveId: 'col_12345678', connectionId: 'con_12345678' };
const proposal = {
  workId: 'work_12345678',
  revision: 1,
  lifecycle: 'proposed',
  sourceEventId: 'evt_12345678',
  sourceLocation: { channelId: 'general' },
  proposedRequestKind: 'guide',
  proposedBy: { kind: 'agent', humanId: 'human_12345678', connectionId: coordinates.connectionId, catId: 'codex-sol' },
};
const base = {
  ...coordinates,
  type: 'collective:host-work-policy-command',
  bridgeId: 'bridge_12345678',
  contextId: 'context_12345678',
  contextRevision: 1,
  humanId: 'human_12345678',
  commandId: 'command_12345678',
};
const store = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
};

describe('Human command consumer (scripted Service response fixture)', () => {
  it('allows only the exact original source once, preserving manual mode and other rules', async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, body });
      if (path.endsWith('read-owner'))
        return {
          policy: { revision: 2, decisionMode: 'manual', ownerHumanId: base.humanId, grants: [], history: [] },
        } as T;
      if (path.startsWith('/api/collaboration?')) return { works: [proposal] } as T;
      return { revision: 3, grants: [{ ...body.grants[0], grantRevision: 1, status: 'active' }] } as T;
    };
    const result = await executeHostWorkPolicyCommand({
      command: {
        ...base,
        action: { kind: 'allow_request', workId: proposal.workId, workRevision: 1, permission: 'once' },
      },
      request,
      storage: store(),
    });
    const payload = calls.find((call) => call.path.endsWith('/register'))?.body;
    expect(payload?.decisionMode).toBe('manual');
    expect(payload?.grants).toMatchObject([
      {
        catIds: ['codex-sol'],
        channelIds: ['general'],
        requestKinds: ['guide'],
        sourceEventIds: [proposal.sourceEventId],
      },
    ]);
    expect(result).toEqual({ policyRevision: 3, grantRef: `owner-rule:${base.commandId}`, grantRevision: 1 });
    expect(JSON.stringify(result)).not.toContain('Bearer');
    expect(calls.some((call) => /commit|accept-agent/.test(call.path))).toBe(false);
  });
  it('registers a class override without changing the global manual decision', async () => {
    const calls: Record<string, unknown>[] = [];
    const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push(body);
      if (path.endsWith('read-owner'))
        return {
          policy: { revision: 1, decisionMode: 'manual', ownerHumanId: base.humanId, grants: [], history: [] },
        } as T;
      if (path.startsWith('/api/collaboration?')) return { works: [proposal] } as T;
      return { revision: 2, grants: [{ ...body.grants[0], grantRevision: 1, status: 'active' }] } as T;
    };
    await executeHostWorkPolicyCommand({
      command: {
        ...base,
        action: { kind: 'allow_request', workId: proposal.workId, workRevision: 1, permission: 'class' },
      },
      request,
      storage: store(),
    });
    const body = calls.find((value) => value.grants);
    expect(body?.decisionMode).toBe('manual');
    expect(body?.grants).toMatchObject([
      { decisionMode: 'automatic', catIds: ['codex-sol'], channelIds: ['general'], requestKinds: ['guide'] },
    ]);
    expect(JSON.stringify(body)).not.toContain('sourceEventIds');
  });
  it('rejects foreign, changed or raw request proposals before any registration', async () => {
    for (const wrong of [
      { ...proposal, revision: 2 },
      { ...proposal, proposedBy: { ...proposal.proposedBy, connectionId: 'con_foreign1' } },
      { ...proposal, proposedRequestKind: undefined },
    ]) {
      const paths: string[] = [];
      const request = async <T>(path: string): Promise<T> => {
        paths.push(path);
        return (path.endsWith('read-owner') ? { policy: null } : { works: [wrong] }) as T;
      };
      await expect(
        executeHostWorkPolicyCommand({
          command: {
            ...base,
            action: { kind: 'allow_request', workId: proposal.workId, workRevision: 1, permission: 'once' },
          },
          request,
          storage: store(),
        }),
      ).rejects.toThrow();
      expect(paths.some((path) => path.endsWith('/register'))).toBe(false);
    }
  });
});
