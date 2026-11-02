import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { initialState } from '../hub-cat-editor.model';
import { buildMemberPatchPayload } from '../hub-cat-editor.payload';
import { MemberAdvancedFields } from '../settings/members/MemberAdvancedFields';

for (const agentProvider of [
  undefined,
  'plugin:official.codeagent/codeagent',
  'plugin:example.clients/directory-agent',
]) {
  test(`one member approval control for ${agentProvider ?? 'native ACP'} preserves launch settings`, async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const cat: CatData = {
      id: 'member-a',
      name: 'Partner',
      displayName: 'Partner',
      roleDescription: '',
      personality: '',
      avatar: '',
      clientId: 'acp',
      carrier: 'acp',
      defaultModel: '',
      mcpSupport: false,
      color: { primary: '#123456', secondary: '#abcdef' },
      mentionPatterns: ['@partner'],
      ...(agentProvider ? { agentProvider } : {}),
      acp: { command: 'existing-agent', startupArgs: ['--acp', '--profile', 'existing'], transport: 'stdio' },
    };
    let form = initialState(cat);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = () =>
      root.render(
        <MemberAdvancedFields
          form={form}
          patch={(change) => {
            form = { ...form, ...change };
          }}
          t={(zh) => zh}
          fields={() => null}
        />,
      );
    try {
      act(render);
      const select = Array.from(container.querySelectorAll('select')).find((el) =>
        el.closest('label')?.textContent?.startsWith('ACP 执行确认'),
      )!;
      expect(select).toBeDefined();
      expect(select.value).toBe('auto');
      act(() => {
        select.value = 'ask_user';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(form.executionApproval).toBe('ask_user');
      const patch = buildMemberPatchPayload(form, cat);
      expect(patch.executionApproval).toBe('ask_user');
      expect(patch.acp).toBeUndefined();
      expect(patch.agentProvider).toBeUndefined();
      const reloaded = initialState({ ...cat, executionApproval: 'ask_user' });
      expect(reloaded.executionApproval).toBe('ask_user');
      expect(
        buildMemberPatchPayload(reloaded, { ...cat, executionApproval: 'ask_user' }).executionApproval,
      ).toBeUndefined();
      expect(
        buildMemberPatchPayload({ ...reloaded, executionApproval: 'auto' }, { ...cat, executionApproval: 'ask_user' })
          .executionApproval,
      ).toBe('auto');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
}
