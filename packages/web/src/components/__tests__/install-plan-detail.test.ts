import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
  API_URL: 'http://localhost:3102',
}));

import { apiFetch } from '@/utils/api-client';
import { InstallPlanDetail } from '../marketplace/install-plan-detail';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

const MOCK_RESULT = {
  ecosystem: 'claude' as const,
  artifactId: 'filesystem',
  artifactKind: 'mcp_server' as const,
  displayName: 'Filesystem',
  componentSummary: 'File operations',
  sourceLocator: 'npm:@anthropic-ai/mcp-server-filesystem',
  trustLevel: 'official' as const,
  publisherIdentity: 'Anthropic',
};

const MOCK_PLAN_DIRECT = {
  mode: 'direct_mcp' as const,
  mcpEntry: {
    id: 'filesystem',
    command: 'npx',
    args: ['-y', '@anthropic-ai/mcp-server-filesystem', '/Users'],
  },
  metadata: { versionRef: '0.6.2' },
};

describe('InstallPlanDetail direct_mcp install', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('POST body includes projectPath when provided', async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await act(async () => {
      root.render(
        React.createElement(InstallPlanDetail, {
          result: MOCK_RESULT,
          plan: MOCK_PLAN_DIRECT,
          projectPath: '/workspace/my-project',
          onBack: vi.fn(),
          onInstalled: vi.fn(),
        }),
      );
    });
    await flushEffects();

    const installBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('安装到当前猫猫'),
    );
    expect(installBtn).toBeTruthy();
    expect(installBtn?.disabled).toBe(false);

    await act(async () => {
      installBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/capabilities/mcp/install',
      expect.objectContaining({ method: 'POST' }),
    );
    const callBody = JSON.parse((mockApiFetch.mock.calls[0][1] as { body: string }).body);
    expect(callBody.projectPath).toBe('/workspace/my-project');
    expect(callBody.id).toBe('filesystem');
    expect(callBody.command).toBe('npx');
  });

  it('calls onInstalled after successful install', async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const onInstalled = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(InstallPlanDetail, {
          result: MOCK_RESULT,
          plan: MOCK_PLAN_DIRECT,
          onBack: vi.fn(),
          onInstalled,
        }),
      );
    });
    await flushEffects();

    const installBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('安装到当前猫猫'),
    );

    await act(async () => {
      installBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(onInstalled).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('已安装');
  });

  it('does not call onInstalled on failed install', async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse({ error: 'owner required' }, 403));
    const onInstalled = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(InstallPlanDetail, {
          result: MOCK_RESULT,
          plan: MOCK_PLAN_DIRECT,
          onBack: vi.fn(),
          onInstalled,
        }),
      );
    });
    await flushEffects();

    const installBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('安装到当前猫猫'),
    );

    await act(async () => {
      installBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(onInstalled).not.toHaveBeenCalled();
    expect(container.textContent).toContain('owner required');
  });

  it('omits projectPath from body when not provided', async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await act(async () => {
      root.render(
        React.createElement(InstallPlanDetail, {
          result: MOCK_RESULT,
          plan: MOCK_PLAN_DIRECT,
          onBack: vi.fn(),
        }),
      );
    });
    await flushEffects();

    const installBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('安装到当前猫猫'),
    );

    await act(async () => {
      installBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const callBody = JSON.parse((mockApiFetch.mock.calls[0][1] as { body: string }).body);
    expect(callBody.projectPath).toBeUndefined();
  });
});
