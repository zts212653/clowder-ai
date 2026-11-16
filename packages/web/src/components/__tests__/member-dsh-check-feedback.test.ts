import { expect, it } from 'vitest';
import { dshConnectionCheckMessage } from '../settings/members/dsh-connection-check-client';

it('separates successful creation from a specific schema failure and does not claim the connection is merely pending', () => {
  const message = dshConnectionCheckMessage({ state: 'failed', reasonCode: 'tool_schema_rejected' });
  expect(message).toContain('工具配置被模型拒绝，暂时无法回复');
  expect(message).toContain('更新出错插件');
  expect(message).toContain('无需重新添加成员');
  expect(message).not.toContain('Collective');
  expect(message).not.toContain('原因尚不明确');
  expect(message).not.toContain('重试检查');
});

it('does not describe an untested model as disconnected or verified', () => {
  const message = dshConnectionCheckMessage({ state: 'unchecked' });
  expect(message).toContain('可以直接聊天');
  expect(message).not.toMatch(/失败|无法|已连接/);
});

it('keeps unknown results honest without presenting an unchanged paid retry as the recovery', () => {
  const text = dshConnectionCheckMessage({ state: 'unknown', reasonCode: 'check_result_unknown' });
  expect(text).toContain('原因尚不明确');
  expect(text).not.toContain('重试检查或直接聊天');
  expect(text).not.toContain('网络');
});

it('keeps a connected model separate from unavailable optional plugin tools', () => {
  const view = {
    state: 'passed' as const,
    toolIssues: [
      { pluginId: 'fixture', capabilityId: 'plugin:fixture:broken', reasonCode: 'tool_schema_invalid' as const },
    ],
  };
  expect(dshConnectionCheckMessage(view)).toContain('模型已连接');
  expect(dshConnectionCheckMessage(view)).toContain('插件工具暂不可用');
  expect(dshConnectionCheckMessage(view)).not.toContain('暂时无法回复');
  const unchecked = dshConnectionCheckMessage({ ...view, state: 'unchecked' });
  expect(unchecked).toContain('fixture');
  expect(unchecked).toContain('插件工具暂不可用');
  expect(unchecked).not.toContain('已连接');
  const stale = dshConnectionCheckMessage({
    state: 'stale',
    fact: {
      catId: 'whale',
      attemptId: 'historical',
      effectiveFingerprint: 'old-config',
      toolManifestHash: 'old-tools',
      phase: 'terminal',
      outcome: 'passed',
      startedAt: 1,
      toolIssues: view.toolIssues,
    },
  });
  expect(stale).not.toContain('fixture');
  expect(stale).not.toContain('插件工具暂不可用');
});

it('reports an unavailable runtime without misdiagnosing its tool definitions', () => {
  const message = dshConnectionCheckMessage({
    state: 'unchecked',
    toolIssues: [
      { pluginId: 'fixture', capabilityId: 'plugin:fixture:broken', reasonCode: 'plugin_activation_unavailable' },
    ],
  });
  expect(message).toContain('插件运行不可用');
  expect(message).not.toContain('工具定义无效');
  expect(message).toContain('可以直接聊天');
});

it.each([
  'checking',
  'unchecked',
  'passed',
] as const)('keeps mixed failure causes attached to the right plugin (%s)', (state) => {
  const message = dshConnectionCheckMessage({
    state,
    toolIssues: [
      {
        pluginId: 'crashed-plugin',
        capabilityId: 'plugin:crashed-plugin:main',
        reasonCode: 'plugin_activation_unavailable',
      },
      {
        pluginId: 'bad-schema-plugin',
        capabilityId: 'plugin:bad-schema-plugin:main',
        reasonCode: 'tool_schema_invalid',
      },
    ],
  });
  expect(message).toContain('crashed-plugin（插件运行不可用）');
  expect(message).toContain('bad-schema-plugin（工具定义无效）');
  expect(message).not.toContain('暂时无法回复');
  expect(message).not.toContain('bad-schema-plugin（插件运行不可用）');
});

it('retains both causes when different capabilities of one plugin fail', () => {
  const message = dshConnectionCheckMessage({
    state: 'unchecked',
    toolIssues: [
      { pluginId: 'mixed', capabilityId: 'plugin:mixed:offline', reasonCode: 'plugin_activation_unavailable' },
      { pluginId: 'mixed', capabilityId: 'plugin:mixed:bad-schema', reasonCode: 'tool_schema_invalid' },
      { pluginId: 'mixed', capabilityId: 'plugin:mixed:another-offline', reasonCode: 'plugin_activation_unavailable' },
    ],
  });
  expect(message).toContain('mixed（插件运行不可用、工具定义无效）');
  expect(message.match(/mixed/g)).toHaveLength(1);
  expect(message).toContain('可以直接聊天');
});
