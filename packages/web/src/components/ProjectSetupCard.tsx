/**
 * F113 Phase E: ProjectSetupCard
 * Shown for blank repositories as an optional Git/setup aid.
 * Governance materialization is a separate preview-first choice.
 */
import Image from 'next/image';
import { useCallback, useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { apiFetch } from '@/utils/api-client';
import { AgentHookHealthNotice, type AgentHookStatusResponse } from './AgentHookHealthNotice';
import { GovernanceInstaller } from './GovernanceInstaller';
import { HubIcon } from './hub-icons';

/* Anime-style cat illustrations generated via Gemini */

interface ProjectSetupCardProps {
  projectPath: string;
  isEmptyDir: boolean;
  isGitRepo: boolean;
  gitAvailable: boolean;
  onComplete: () => void;
  agentHookHealth?: AgentHookStatusResponse | null;
  agentHookHealthError?: string | null;
  agentHookSyncing?: boolean;
  agentHookSynced?: boolean;
  agentHookSyncAttempted?: boolean;
  onSyncAgentHooks?: () => void | Promise<void>;
}

type CardState = 'idle' | 'processing' | 'done' | 'error';

const ERROR_LABELS: Record<string, string> = {
  auth_failed: '认证失败，请检查仓库权限',
  network_error: '网络错误，无法连接到 Git 服务器',
  not_found: '仓库不存在，请检查 URL',
  not_empty: '目录不为空，无法克隆',
  timeout: '克隆超时（120秒），仓库可能过大',
  git_unavailable: '未检测到 Git，请先安装',
  unknown: '克隆失败，请检查 Git 配置或仓库状态',
};

export function ProjectSetupCard({
  projectPath,
  isEmptyDir,
  isGitRepo,
  gitAvailable,
  onComplete,
  agentHookHealth,
  agentHookHealthError,
  agentHookSyncing,
  agentHookSynced,
  agentHookSyncAttempted,
  onSyncAgentHooks,
}: ProjectSetupCardProps) {
  const [state, setState] = useState<CardState>('idle');
  const [cloneUrl, setCloneUrl] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const ime = useIMEGuard();

  const dirName = projectPath.split(/[/\\]/).pop() ?? projectPath;

  const handleSetup = useCallback(
    async (mode: 'clone' | 'init' | 'skip') => {
      setState('processing');
      setErrorMsg('');
      try {
        const payload: Record<string, string> = { projectPath, mode };
        if (mode === 'clone') payload.gitCloneUrl = cloneUrl.trim();

        // Run API call and minimum display time in parallel so fast ops don't flash
        const MIN_DISPLAY_MS = 1200;
        const [res] = await Promise.all([
          apiFetch('/api/projects/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }),
          new Promise((r) => setTimeout(r, MIN_DISPLAY_MS)),
        ]);

        if (!res.ok) {
          const data = await res.json();
          const kind = data.errorKind as string | undefined;
          setState('error');
          setErrorMsg(kind ? (ERROR_LABELS[kind] ?? data.error) : (data.error ?? '初始化失败'));
          return;
        }

        setState('done');
        onComplete();
      } catch {
        setState('error');
        setErrorMsg('网络错误');
      }
    },
    [projectPath, cloneUrl, onComplete],
  );

  // Processing and done states: Git/project setup remains separate from governance.
  if (state === 'processing' || state === 'done') {
    return (
      <div data-testid="project-setup-card" className="flex justify-center mb-3">
        <div
          className={`max-w-[85%] w-full rounded-lg border p-4 ${state === 'done' ? 'border-semantic-success bg-semantic-success-surface' : 'border-semantic-warning bg-semantic-warning-surface'}`}
        >
          <div className="flex items-center gap-4">
            <Image
              src={state === 'done' ? '/images/setup-cat-done.png' : '/images/setup-cat-working.png'}
              alt={state === 'done' ? '完成' : '工作中'}
              width={80}
              height={80}
              className="flex-shrink-0 object-contain"
            />
            <div className="flex-1 min-w-0">
              <p
                className={`text-sm font-medium ${state === 'done' ? 'text-semantic-success' : 'text-semantic-warning'}`}
              >
                项目{' '}
                <code
                  className={`px-1 py-0.5 rounded text-xs ${state === 'done' ? 'bg-semantic-success-surface' : 'bg-semantic-warning-surface'}`}
                >
                  {dirName}
                </code>{' '}
                {state === 'done' ? '工作区已就绪' : '正在设置工作区'}
              </p>
              <p className={`text-xs mt-1 ${state === 'done' ? 'text-semantic-success' : 'text-semantic-warning'}`}>
                {state === 'done'
                  ? 'Git/目录设置已完成；没有自动写入治理文件。'
                  : '只执行你选择的 Git/目录动作，不写治理文件。'}
              </p>
              <div className="mt-2">
                {state === 'processing' && (
                  <span className="text-sm text-semantic-warning animate-pulse">正在设置...</span>
                )}
                {state === 'done' && <span className="text-sm text-semantic-success">猫猫可以直接开工</span>}
              </div>
            </div>
          </div>
          {state === 'done' && (
            <div className="mt-4 space-y-3">
              <GovernanceInstaller projectPath={projectPath} recommendedProjectGuide={isEmptyDir} />
              {onSyncAgentHooks && (
                <AgentHookHealthNotice
                  health={agentHookHealth ?? null}
                  error={agentHookHealthError}
                  syncing={agentHookSyncing}
                  synced={agentHookSynced}
                  syncAttempted={agentHookSyncAttempted}
                  onSync={onSyncAgentHooks}
                />
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="project-setup-card" className="flex justify-center mb-3">
      <div className="max-w-[85%] w-full rounded-lg border border-cafe-accent/20 bg-cafe-surface/30 p-5">
        {/* Header */}
        <div className="flex items-center gap-4 mb-4">
          <Image
            src="/images/setup-cat-idle.png"
            alt="设置"
            width={80}
            height={80}
            className="flex-shrink-0 object-contain"
          />
          <div>
            <p className="text-sm font-medium text-cafe-black">发现了一片新大陆！</p>
            <p className="text-xs text-cafe-muted mt-0.5">
              项目 <code className="px-1 py-0.5 bg-cafe-surface rounded text-micro">{dirName}</code>{' '}
              {isEmptyDir ? '是空目录。' : ''}猫猫已经可以工作；Git 设置是可选的。
            </p>
          </div>
        </div>

        {state === 'error' && (
          <div className="mb-3 px-3 py-2 rounded bg-semantic-critical-surface border border-semantic-critical">
            <p className="text-xs text-semantic-critical">{errorMsg}</p>
            <button
              type="button"
              onClick={() => setState('idle')}
              className="text-xs text-semantic-critical underline mt-1"
            >
              重试
            </button>
          </div>
        )}

        {state === 'idle' && (
          <div className="space-y-3">
            {onSyncAgentHooks && (
              <AgentHookHealthNotice
                health={agentHookHealth ?? null}
                error={agentHookHealthError}
                syncing={agentHookSyncing}
                synced={agentHookSynced}
                syncAttempted={agentHookSyncAttempted}
                onSync={onSyncAgentHooks}
              />
            )}
            <p className="text-xs text-cafe-muted font-medium">需要的话，选择一种开荒方式：</p>

            {/* Option 1: Clone (recommended) */}
            {isEmptyDir && gitAvailable && !isGitRepo && (
              <div className="rounded-xl ring-1 ring-cafe-accent/30 p-4 hover:bg-cafe-accent/[0.03] transition-colors">
                <div className="flex items-center gap-3 mb-2.5">
                  <HubIcon name="folder" className="h-5 w-5 text-cafe-accent" />
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-cafe-black">克隆 Git 仓库</span>
                    <span className="text-micro px-1.5 py-0.5 rounded-full bg-cafe-accent/10 text-cafe-accent font-medium">
                      推荐
                    </span>
                  </div>
                </div>
                <p className="text-xs text-cafe-muted mb-3 ml-8">将现有的代码宝藏搬到新营地，包含完整历史记录。</p>
                <div className="flex gap-2 ml-8">
                  <input
                    type="text"
                    value={cloneUrl}
                    onChange={(e) => setCloneUrl(e.target.value)}
                    onCompositionStart={ime.onCompositionStart}
                    onCompositionEnd={ime.onCompositionEnd}
                    placeholder="https:// 或 git@..."
                    className="flex-1 text-xs px-3 py-2 rounded-lg border border-[var(--console-border-soft)] bg-cafe-surface-canvas focus:outline-none focus:ring-1 focus:ring-cafe-accent"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && ime.isComposing()) {
                        e.preventDefault();
                        return;
                      }
                      if (e.key === 'Enter' && cloneUrl.trim()) handleSetup('clone');
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => handleSetup('clone')}
                    disabled={!cloneUrl.trim()}
                    className="min-w-[6.5rem] px-4 py-2 rounded-lg bg-cafe-accent hover:bg-cafe-interactive text-[var(--cafe-surface)] text-xs font-medium transition-colors disabled:opacity-40"
                  >
                    立即拉取
                  </button>
                </div>
              </div>
            )}

            {/* Option 2: Git init */}
            {gitAvailable && !isGitRepo && (
              <div className="rounded-xl ring-1 ring-cafe-accent/30 p-4 hover:bg-cafe-accent/[0.03] transition-colors">
                <div className="flex items-center gap-3">
                  <HubIcon name="terminal" className="h-5 w-5 text-cafe-accent" />
                  <div className="flex-1">
                    <span className="text-sm font-semibold text-cafe-black">初始化全新项目</span>
                    <p className="text-xs text-cafe-muted mt-0.5">只创建 Git 仓库；治理文件稍后单独预览。</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleSetup('init')}
                    className="min-w-[6.5rem] px-4 py-2 rounded-lg bg-cafe-accent hover:bg-cafe-interactive text-[var(--cafe-surface)] text-xs font-medium transition-colors"
                  >
                    初始化
                  </button>
                </div>
              </div>
            )}

            {/* Option 3: Skip git */}
            <div className="rounded-xl ring-1 ring-cafe-accent/30 p-4 hover:bg-cafe-accent/[0.03] transition-colors">
              <div className="flex items-center gap-3">
                <HubIcon name="settings" className="h-5 w-5 text-cafe-accent" />
                <div className="flex-1">
                  <span className="text-sm font-semibold text-cafe-black">
                    {isGitRepo ? '保持现有仓库' : '不使用 Git'}
                  </span>
                  <p className="text-xs text-cafe-muted mt-0.5">
                    {isGitRepo ? '不改仓库内容，直接进入可选治理预览。' : '直接开工；版本回溯和代码审查能力将不可用。'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleSetup('skip')}
                  className="min-w-[6.5rem] px-4 py-2 rounded-lg bg-cafe-accent hover:bg-cafe-interactive text-[var(--cafe-surface)] text-xs font-medium transition-colors"
                >
                  直接开始
                </button>
              </div>
            </div>

            {/* Explanation */}
            <p className="text-micro text-cafe-muted px-1 mt-1">
              本步骤只处理克隆或 Git 初始化。项目治理是下一步的独立可选项，先预览、再确认。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
