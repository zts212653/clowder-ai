import type { ManagedCommandActivity } from '@cat-cafe/shared';

const LABELS: Record<ManagedCommandActivity, string> = {
  full_gate: '全量门禁',
  test: '测试',
  build: '构建',
  lint: '代码检查',
  check: '专项检查',
  command: '托管命令',
};

export function managedCommandActivityLabel(activity: ManagedCommandActivity | undefined): string {
  return (activity && LABELS[activity]) ?? '托管命令';
}
