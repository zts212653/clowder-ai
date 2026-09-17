import type { LocalCollectiveServiceStatus } from './collective-client';

export function localServiceAction(state: LocalCollectiveServiceStatus['state'] | undefined, busy: boolean) {
  if (busy || state === 'starting') return '正在启动 Service…';
  if (state === 'stopped') return '恢复本机 Service';
  if (state === 'setup_required') return '继续设置本机 Service';
  if (state === 'ready') return '打开本机 Service';
  if (state === 'error') return '重新检查本机 Service';
  return '部署新 Service';
}

export function localServiceDescription(state: LocalCollectiveServiceStatus['state']): string {
  const descriptions = {
    not_created: '尚未部署本机 Service。',
    stopped: '已找到本机 Service 数据，进程当前停止；继续后会从原状态恢复。',
    starting: '本机 Service 正在独立启动。',
    setup_required: 'Service 已在线，等待完成首次 Human 与共同家园设置。',
    ready: '本机 Service 已在线并完成首次设置。',
    error: '本机 Service 需要处理后才能继续；现有数据不会被覆盖。',
  } as const;
  return descriptions[state];
}
