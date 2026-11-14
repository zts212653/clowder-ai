import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initialState } from '../hub-cat-editor.model';
import { buildCatPayload } from '../hub-cat-editor.payload';
import { AccountSection } from '../hub-cat-editor.sections';
import { MemberAdvancedFields } from '../settings/members/MemberAdvancedFields';

describe('ACP pool default presentation', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  it.each([
    ['acp', '20'],
    ['opencode', '20'],
    ['google', '3'],
  ] as const)('shows the %s default in both editors without persisting it', async (clientId, placeholder) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const form = {
      ...initialState(null),
      catId: 'pool-default',
      name: 'Pool default',
      displayName: 'Pool default',
      clientId,
      carrier: 'acp' as const,
      acpCommand: 'custom-acp',
      acpStartupArgs: '--acp',
    };
    try {
      await act(async () =>
        root.render(
          <>
            <AccountSection
              form={form}
              modelOptions={[]}
              availableProfiles={[]}
              loadingProfiles={false}
              onChange={vi.fn()}
            />
            <MemberAdvancedFields form={form} patch={vi.fn()} t={(zh) => zh} fields={() => null} />
          </>,
        ),
      );
      const legacy = host.querySelector<HTMLInputElement>('input[aria-label="ACP Max Processes"]');
      const settings = host.querySelector<HTMLInputElement>('input[aria-label="最大进程数"]');
      expect(legacy?.placeholder).toBe(placeholder);
      expect(settings?.placeholder).toBe(placeholder);
      expect(legacy?.value).toBe('');
      expect(settings?.value).toBe('');
      expect(buildCatPayload(form)).not.toHaveProperty('acp.pool.maxLiveProcesses');
      expect(buildCatPayload({ ...form, acpMaxLiveProcesses: '10' })).toMatchObject({
        acp: { pool: { maxLiveProcesses: 10 } },
      });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
