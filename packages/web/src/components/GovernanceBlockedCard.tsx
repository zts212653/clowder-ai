import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { GovernanceInstaller } from './GovernanceInstaller';
import { GovernanceShieldIcon } from './icons/GovernanceShieldIcon';

interface GovernanceBlockedCardProps {
  projectPath: string;
  reasonKind: 'needs_bootstrap' | 'needs_confirmation' | 'files_missing';
  invocationId?: string;
}

type CardState = 'idle' | 'retrying' | 'done' | 'error';

export function GovernanceBlockedCard({ projectPath, invocationId }: GovernanceBlockedCardProps) {
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

  const handleRetry = useCallback(async () => {
    if (!invocationId) return;
    setState('retrying');
    setErrorMsg('');
    try {
      const res = await apiFetch(`/api/invocations/${invocationId}/retry`, { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setState('error');
        setErrorMsg(data.error ?? '重试失败，请手动重新发送消息');
        return;
      }
      setState('done');
    } catch {
      setState('error');
      setErrorMsg('网络错误');
    }
  }, [invocationId]);

  const dirName = projectPath.split(/[/\\]/).pop() ?? projectPath;

  return (
    <div data-testid="governance-blocked-card" className="mb-3 flex justify-center">
      <div className="max-w-[85%] w-full rounded-lg border border-conn-amber-ring bg-conn-amber-bg p-4">
        <div className="flex items-start gap-3">
          <GovernanceShieldIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-conn-amber-text" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-conn-amber-text">
              项目 <code className="rounded bg-conn-amber-bg px-1 py-0.5 text-xs">{dirName}</code> 的历史治理阻塞已解除
            </p>
            <p className="mt-1 text-xs text-conn-amber-text">
              现在派遣不再要求目标仓先安装治理。可以直接重试；若需要项目文件，请在下方预览后显式确认。
            </p>
            {invocationId && (
              <div className="mt-3">
                {(state === 'idle' || state === 'error') && (
                  <button
                    type="button"
                    onClick={() => void handleRetry()}
                    className="rounded-md bg-[var(--semantic-warning)] px-3 py-1.5 text-sm text-[var(--cafe-surface)] hover:opacity-90"
                  >
                    {state === 'error' ? '重试' : '直接重试派遣'}
                  </button>
                )}
                {state === 'retrying' && <span className="text-sm text-conn-amber-text">正在重试...</span>}
                {state === 'done' && <span className="text-sm text-conn-green-text">已重试派遣</span>}
                {state === 'error' && <p className="mt-2 text-sm text-conn-red-text">{errorMsg}</p>}
              </div>
            )}
          </div>
        </div>
        <div className="mt-4">
          <GovernanceInstaller projectPath={projectPath} allowCleanup />
        </div>
      </div>
    </div>
  );
}
