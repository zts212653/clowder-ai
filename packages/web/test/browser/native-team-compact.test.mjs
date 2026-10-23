import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { create, evidence, runtimes, setup } from './native-team-setup.harness.mjs';

// Real production UI with explicit HTTP fixtures. No native client or model is invoked.
for (const provider of ['deepseek-official', 'private-gateway']) {
  test(
    `compact intranet: Claude and configured DSH ${provider} are selected and create without inline settings`,
    { timeout: 30000 },
    async () => {
      const route = {
        status: 'configured',
        sourceProfile: 'desktop',
        revision: 'a'.repeat(64),
        provider,
        model: 'existing-model',
      };
      const prepared = { command: 'fixture', startupArgs: ['dsh', '--patch', '/author/managed/member.yml'] };
      const tools = runtimes
        .filter(({ id }) => ['claude', 'dsh'].includes(id))
        .map((runtime) => ({
          ...runtime,
          kind: 'tool',
          harnessId: runtime.id === 'claude' ? 'claudecode' : 'dsh',
          ...(runtime.id === 'dsh' ? { dshSetupRequired: true, dshSetup: route } : {}),
        }));
      const state = await setup({
        runtimes: tools,
        edition: 'intranet',
        templates: [
          {
            id: 'ragdoll',
            name: '布偶猫',
            nickname: '宪宪',
            avatar: '/avatars/family/opus55.png',
            color: { primary: '#a85820', secondary: '#fff4e8' },
            roleDescription: '主架构师和核心开发者，擅长深度思考和系统设计',
            personality: '温柔且有主见，完成后说明结果',
          },
        ],
        prepareDsh: (body) => {
          assert.deepEqual(body, {
            runtimeId: 'dsh',
            sourceProfile: route.sourceProfile,
            revision: route.revision,
            provider,
            model: route.model,
          });
          return prepared;
        },
      });
      try {
        await state.page.setViewportSize({ width: 1280, height: 800 });
        for (const label of ['Claude Code', 'DSH']) {
          const checkbox = state.panel.getByRole('checkbox', { name: `加入 ${label} 伙伴`, exact: true });
          assert.equal(await checkbox.isChecked(), true);
          assert.equal(await checkbox.isEnabled(), true);
        }
        assert.equal(await state.panel.getByRole('heading', { name: '布偶猫 · 宪宪', exact: true }).isVisible(), true);
        assert.equal(await state.panel.getByRole('button', { name: /^(调整|收起)$/ }).count(), 0);
        assert.equal(await state.panel.locator('fieldset,input:not([type=checkbox]),select,textarea').count(), 0);
        assert.equal(state.preparations.length, 0, 'Discovery must not write a member patch');
        assert.equal(state.writes.length, 0);
        assert.equal(
          state.requests.some(({ path: requestPath }) => requestPath.includes('/dsh-setup/inspect')),
          false,
        );
        await state.page.screenshot({ path: path.join(evidence, `compact-${provider}.png`), fullPage: true });
        await create(state.page).click();
        await state.panel.waitFor({ state: 'hidden' });
        assert.equal(state.preparations.length, 1);
        assert.equal(state.writes.length, 2);
        const dsh = state.writes.find(({ payload }) => payload.clientId === 'acp').payload;
        assert.equal(dsh.acp.command, prepared.command);
        assert.deepEqual(dsh.acp.startupArgs, prepared.startupArgs);
        assert.equal(dsh.defaultModel ?? '', '', 'The owned patch remains the native model authority');
        assert.deepEqual(state.errors, []);
      } finally {
        await state.context.close();
      }
    },
  );
}

test(
  'missing Claude login and DSH credentials never appear as usable recommended partners',
  { timeout: 30000 },
  async () => {
    const state = await setup({
      edition: 'intranet',
      runtimes: runtimes
        .filter(({ id }) => ['claude', 'dsh'].includes(id))
        .map((runtime) => ({
          ...runtime,
          ...(runtime.id === 'claude'
            ? { readiness: { status: 'login_required', loginCommand: 'claude auth login' } }
            : { dshSetupRequired: true, dshSetup: { status: 'unavailable', error: 'dsh_setup_no_usable_provider' } }),
        })),
    });
    try {
      await state.page.getByText('还没有找到可加入的工具', { exact: true }).waitFor();
      assert.equal(await create(state.page).count(), 0);
      for (const label of ['Claude Code', 'DSH']) {
        const checkbox = state.panel.getByRole('checkbox', {
          name: `加入 ${label} 伙伴`,
          exact: true,
          includeHidden: true,
        });
        assert.equal(await checkbox.isChecked(), false);
        assert.equal(await checkbox.isDisabled(), true);
      }
      assert.equal(await state.panel.getByRole('button', { name: /^(调整|收起)$/ }).count(), 0);
      assert.equal(await state.panel.locator('fieldset,input:not([type=checkbox]),select,textarea').count(), 0);
      assert.equal(state.writes.length, 0);
      assert.deepEqual(state.errors, []);
    } finally {
      await state.context.close();
    }
  },
);
