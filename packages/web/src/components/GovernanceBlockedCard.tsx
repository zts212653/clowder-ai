import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { GovernanceShieldIcon } from './icons/GovernanceShieldIcon';

interface GovernanceBlockedCardProps {
  projectPath: string;
  reasonKind: 'needs_bootstrap' | 'needs_confirmation' | 'files_missing';
  invocationId?: string;
}

const REASON_LABELS: Record<string, string> = {
  needs_bootstrap: '尚未初始化治理',
  needs_confirmation: '治理初始化待确认',
  files_missing: '治理文件缺失',
};

type CardState = 'idle' | 'confirming' | 'retrying' | 'done' | 'error';

export function GovernanceBlockedCard({ projectPath, reasonKind, invocationId }: GovernanceBlockedCardProps) {
  const [state, setState] = useState<CardState>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const prevInvIdRef = useRef(invocationId);
  useEffect(() => {
    if (prevInvIdRef.current !== invocationId) {
      prevInvIdRef.current = invocationId;
      setState('idle');
      setErrorMsg('');
    }
  }, [invocationId]);

  const handleBootstrap = useCallback(async () => {
    setState('confirming');
    setErrorMsg('');

    try {
      const confirmRes = await apiFetch('/api/governance/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath }),
      });

      if (!confirmRes.ok) {
        const data = (await confirmRes.json()) as { error?: string };
        setState('error');
        setErrorMsg(data.error ?? '治理初始化失败');
        return;
      }

      if (invocationId) {
        setState('retrying');
        const retryRes = await apiFetch(`/api/invocations/${invocationId}/retry`, {
          method: 'POST',
        });

        if (!retryRes.ok) {
          const data = (await retryRes.json()) as { error?: string };
          setState('error');
          setErrorMsg(data.error ?? '重试失败，请手动重新发送消息');
          return;
        }
      }

      setState('done');
    } catch {
      setState('error');
      setErrorMsg('网络错误');
    }
  }, [projectPath, invocationId]);

  const dirName = projectPath.split(/[/\\]/).pop() ?? projectPath;

  return (
    <div data-testid="governance-blocked-card" className="flex justify-center mb-3">
      <div className="max-w-[85%] w-full rounded-lg border border-amber-200 bg-amber-50 p-4">
        <div className="flex items-start gap-3">
          <GovernanceShieldIcon className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-800">
              项目 <code className="px-1 py-0.5 bg-amber-100 rounded text-xs">{dirName}</code>{' '}
              {REASON_LABELS[reasonKind] ?? '治理状态异常'}
            </p>
            <p className="text-xs text-amber-600 mt-1">
              初始化将写入治理规则（CLAUDE.md 等）、Skills 链接和方法论模板到目标项目。已有文件不会被覆盖。
            </p>

            <div className="mt-3">
              {state === 'idle' && (
                <button
                  type="button"
                  onClick={handleBootstrap}
                  className="text-sm px-3 py-1.5 rounded-md bg-amber-500 text-white hover:bg-amber-600 transition-colors"
                >
                  初始化治理并继续
                </button>
              )}
              {state === 'confirming' && <span className="text-sm text-amber-700">正在初始化治理...</span>}
              {state === 'retrying' && <span className="text-sm text-amber-700">治理已就绪，正在重试...</span>}
              {state === 'done' && (
                <span className="text-sm text-green-700">治理初始化完成{invocationId ? '，已自动重试' : ''}</span>
              )}
              {state === 'error' && (
                <div className="space-y-2">
                  <p className="text-sm text-red-600">{errorMsg}</p>
                  <button
                    type="button"
                    onClick={handleBootstrap}
                    className="text-sm px-3 py-1.5 rounded-md bg-amber-500 text-white hover:bg-amber-600 transition-colors"
                  >
                    重试
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
