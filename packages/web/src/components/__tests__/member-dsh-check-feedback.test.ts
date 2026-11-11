import { afterEach, expect, it } from 'vitest';
import { useToastStore } from '@/stores/toastStore';
import {
  dshConnectionCheckMessage,
  showDshConnectionCheckResult,
} from '../settings/members/dsh-connection-check-client';

afterEach(() => useToastStore.setState({ toasts: [] }));

it('separates successful creation from a specific schema failure and does not claim the connection is merely pending', () => {
  showDshConnectionCheckResult('小鲸鱼', { state: 'failed', reasonCode: 'tool_schema_rejected' });
  const toast = useToastStore.getState().toasts[0];
  expect(toast).toBeDefined();
  expect(toast.title).toBe('小鲸鱼已添加');
  expect(toast.message).toContain('工具配置被模型拒绝，暂时无法回复');
  expect(toast.message).toContain('更新出错插件');
  expect(toast.message).toContain('无需重新添加成员');
  expect(toast.message).not.toContain('Collective');
  expect(toast.message).not.toContain('原因尚不明确');
  expect(toast.message).not.toContain('重试检查');
  expect(toast.message).not.toContain('成员与配置已保留');
  expect(toast.message).not.toContain('打开设置');
});

it('uses saved wording when an existing member changes its connection', () => {
  showDshConnectionCheckResult('小鲸鱼', { state: 'failed', reasonCode: 'tool_schema_rejected' }, 'saved');
  expect(useToastStore.getState().toasts[0]?.title).toBe('小鲸鱼已保存');
});

it('keeps unknown results honest without presenting an unchanged paid retry as the recovery', () => {
  const text = dshConnectionCheckMessage({ state: 'unknown', reasonCode: 'check_result_unknown' });
  expect(text).toContain('原因尚不明确');
  expect(text).not.toContain('重试检查或直接聊天');
  expect(text).not.toContain('网络');
  showDshConnectionCheckResult('小鲸鱼', { state: 'passed' });
  expect(useToastStore.getState().toasts).toHaveLength(0);
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
  showDshConnectionCheckResult('小鲸鱼', view);
  expect(useToastStore.getState().toasts[0]?.message).toContain('插件工具暂不可用');
});
