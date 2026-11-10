import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import type { PlatformOperationStatus } from '../../../HubConfigIcons';
import { ActionRenderer } from '../ActionRenderer';

const archive =
  process.env.F202_DOT_UI_ARCHIVE ??
  resolve('../api/src/domains/plugin/bundled-packages/chatgpt-dot/0.2.0-alpha.22/package.tgz');
const member = (path: string) => execFileSync('tar', ['-xOf', archive, `package/${path}`], { encoding: 'utf8' });
const manifest = parse(member('plugin.yaml'));
const mockApiFetch = vi.mocked(apiFetch);
let temporary: string;
let projectDotJourney: (input: Record<string, unknown>) => unknown;

function operation(key: string): PlatformOperationStatus {
  const field = manifest.configuration.find((candidate: { key: string }) => candidate.key === key);
  return {
    name: key,
    label: field.label,
    actions: field.actions.filter((action: { render: string }) => action.render !== 'row'),
    rowActions: field.actions.filter((action: { render: string }) => action.render === 'row'),
    ...(key === 'connection' ? {} : { currentAction: 'show-instructions' }),
  };
}

describe('packed Dot Work setup through the real Host action renderer', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeAll(async () => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    temporary = await mkdtemp(join(tmpdir(), 'dot-ui-projection-'));
    const modulePath = join(temporary, 'journey-projection.mjs');
    await writeFile(modulePath, member('dist/journey-projection.js'));
    // Load the exact packed JS outside Vite's source graph (Node 24 ESM require).
    ({ projectDotJourney } = createRequire(import.meta.url)(modulePath));
  });
  afterAll(async () => {
    await rm(temporary, { recursive: true, force: true });
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ['fresh', 'connection'],
    ['expired', 'connection'],
    ['fresh', 'temporaryEndpoint'],
    ['expired', 'temporaryEndpoint'],
    ['fresh', 'longLivedEndpoint'],
    ['expired', 'longLivedEndpoint'],
  ])('%s pairing: %s message stays copyable while subscription advances to roundtrip', async (initial, source) => {
    const now = Date.now();
    const old = {
      attemptId: 'old',
      pairingExpiresAt: now - 1,
      pairedAt: null,
      revokedAt: null,
      subscription: null,
      testEventIds: [],
    };
    let connection: typeof old | null = initial === 'expired' ? old : null;
    let subscribed = false;
    const instructions = '请连接这个 Work 对话：events/subscribe dot.summoned pairing_code=fixture';
    const data = () =>
      projectDotJourney({
        runtimeRunning: true,
        now: Date.now(),
        dispatches: [],
        connection: connection && {
          ...connection,
          ...(subscribed ? { pairedAt: now, subscription: { expiresAt: null } } : {}),
        },
        external: {
          v: 1,
          revision: 1,
          pending: null,
          current: { kind: 'legacy', recordRef: 'host.external' },
          endpoint: { mode: 'long-lived', serverUrl: 'https://fixture.example/mcp', reachableAt: now },
        },
      });
    mockApiFetch.mockImplementation(async (url) => {
      const action = String(url).split('/').at(-1);
      if (action === 'status') return new Response(JSON.stringify({ ok: true, render: 'rows', data: data() }));
      if (action === 'show-instructions') {
        connection = { ...old, attemptId: 'new', pairingExpiresAt: now + 30 * 60_000 };
        return new Response(JSON.stringify({ ok: true, render: 'text', data: instructions }));
      }
      throw new Error(`Unexpected action ${action}`);
    });
    const target = { kind: 'plugin', id: manifest.pluginId } as const;
    act(() =>
      root.render(
        <>
          {source !== 'connection' && (
            <section data-testid="entry">
              <ActionRenderer target={target} operation={operation(source)} />
            </section>
          )}
          <section data-testid="connection">
            <ActionRenderer target={target} operation={operation('connection')} />
          </section>
        </>,
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const scope = container.querySelector(`[data-testid="${source === 'connection' ? 'connection' : 'entry'}"]`)!;
    const button = [...scope.querySelectorAll('button')].find((item) => item.textContent === '获取连接消息');
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
    });
    if (source !== 'connection')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
    const connectionSection = container.querySelector('[data-testid="connection"]')!;
    expect(connectionSection.textContent).toContain('等待 ChatGPT 连接');
    expect(container.textContent).toContain(instructions);
    expect([...container.querySelectorAll('button')].some((item) => item.textContent === '复制')).toBe(true);
    subscribed = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(
      connectionSection.querySelector(
        `[data-testid="${manifest.pluginId}-row-verification-required-action-roundtrip"]`,
      ),
    ).not.toBeNull();
    expect(container.textContent).toContain(instructions);
  });
});
