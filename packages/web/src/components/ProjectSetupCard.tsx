/**
 * F113 Phase E: ProjectSetupCard
 * Shown when a thread opens with a project that needs governance bootstrap.
 * Three options: clone repo / git init / skip git.
 * Separate from GovernanceBlockedCard (which handles dispatch-failure retry).
 */
import Image from 'next/image';
import { useCallback, useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { apiFetch } from '@/utils/api-client';
import { AgentHookHealthNotice, type AgentHookStatusResponse } from './AgentHookHealthNotice';
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

  // Processing and done states: full card with icon (matches GovernanceBlockedCard)
  if (state === 'processing' || state === 'done') {
    return (
      <div data-testid="project-setup-card" className="flex justify-center mb-3">
        <div
          className={`max-w-[85%] w-full rounded-lg border p-4 ${state === 'done' ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'}`}
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
              <p className={`text-sm font-medium ${state === 'done' ? 'text-green-800' : 'text-amber-800'}`}>
                项目{' '}
                <code className={`px-1 py-0.5 rounded text-xs ${state === 'done' ? 'bg-green-100' : 'bg-amber-100'}`}>
                  {dirName}
                </code>{' '}
                {state === 'done' ? '初始化完成' : '正在初始化'}
              </p>
              <p className={`text-xs mt-1 ${state === 'done' ? 'text-green-600' : 'text-amber-600'}`}>
                {state === 'done'
                  ? '协作规则（CLAUDE.md 等）、Skills 链接和方法论模板已就绪。'
                  : '正在写入协作规则（CLAUDE.md 等）、Skills 链接和方法论模板...'}
              </p>
              <div className="mt-2">
                {state === 'processing' && (
                  <span className="text-sm text-amber-700 animate-pulse">正在初始化治理...</span>
                )}
                {state === 'done' && <span className="text-sm text-green-700">治理初始化完成，猫猫已就绪</span>}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="project-setup-card" className="flex justify-center mb-3">
      <div className="max-w-[85%] w-full rounded-lg border border-cocreator-primary/20 bg-cocreator-bg/30 p-5">
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
            <p className="text-xs text-gray-500 mt-0.5">
              项目 <code className="px-1 py-0.5 bg-cocreator-bg rounded text-[10px]">{dirName}</code>{' '}
              {isEmptyDir ? '是空目录，' : ''}需要初始化后猫猫才能工作。
            </p>
          </div>
        </div>

        {state === 'error' && (
          <div className="mb-3 px-3 py-2 rounded bg-red-50 border border-red-200">
            <p className="text-xs text-red-600">{errorMsg}</p>
            <button type="button" onClick={() => setState('idle')} className="text-xs text-red-500 underline mt-1">
              重试
            </button>
          </div>
        )}

        {state === 'idle' && (
          <div className="space-y-3">
            {onSyncAgentHooks && (
              <AgentHookHealthNotice
                health={agentHookHealth ? agentHookHealth : null}
                error={agentHookHealthError}
                syncing={agentHookSyncing}
                synced={agentHookSynced}
                onSync={onSyncAgentHooks}
              />
            )}

            <p className="text-xs text-gray-500 font-medium">请选择你的开荒方式：</p>

            {/* Option 1: Clone (recommended) */}
            {isEmptyDir && gitAvailable && !isGitRepo && (
              <div className="rounded-xl ring-1 ring-cocreator-primary/30 p-4 hover:bg-cocreator-primary/[0.03] transition-colors">
                <div className="flex items-center gap-3 mb-2.5">
                  <HubIcon name="folder" className="h-5 w-5 text-cocreator-primary" />
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-cafe-black">克隆 Git 仓库</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-cocreator-primary/10 text-cocreator-primary font-medium">
                      推荐
                    </span>
                  </div>
                </div>
                <p className="text-[11px] text-gray-500 mb-3 ml-8">将现有的代码宝藏搬到新营地，包含完整历史记录。</p>
                <div className="flex gap-2 ml-8">
                  <input
                    type="text"
                    value={cloneUrl}
                    onChange={(e) => setCloneUrl(e.target.value)}
                    onCompositionStart={ime.onCompositionStart}
                    onCompositionEnd={ime.onCompositionEnd}
                    placeholder="https:// 或 git@..."
                    className="flex-1 text-xs px-3 py-2 rounded-lg border border-gray-200 bg-white focus:outline-none focus:ring-1 focus:ring-cocreator-primary"
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
                    className="min-w-[6.5rem] px-4 py-2 rounded-lg bg-cocreator-primary hover:bg-cocreator-dark text-white text-xs font-medium transition-colors disabled:opacity-40"
                  >
                    立即拉取
                  </button>
                </div>
              </div>
            )}

            {/* Option 2: Git init */}
            {gitAvailable && !isGitRepo && (
              <div className="rounded-xl ring-1 ring-cocreator-primary/30 p-4 hover:bg-cocreator-primary/[0.03] transition-colors">
                <div className="flex items-center gap-3">
                  <HubIcon name="terminal" className="h-5 w-5 text-cocreator-primary" />
                  <div className="flex-1">
                    <span className="text-sm font-semibold text-cafe-black">初始化全新项目</span>
                    <p className="text-[11px] text-gray-500 mt-0.5">从零开始，为你铺设标准的协作规则和猫砂盆。</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleSetup('init')}
                    className="min-w-[6.5rem] px-4 py-2 rounded-lg bg-cocreator-primary hover:bg-cocreator-dark text-white text-xs font-medium transition-colors"
                  >
                    初始化
                  </button>
                </div>
              </div>
            )}

            {/* Option 3: Skip git */}
            <div className="rounded-xl ring-1 ring-cocreator-primary/30 p-4 hover:bg-cocreator-primary/[0.03] transition-colors">
              <div className="flex items-center gap-3">
                <HubIcon name="settings" className="h-5 w-5 text-cocreator-primary" />
                <div className="flex-1">
                  <span className="text-sm font-semibold text-cafe-black">
                    {isGitRepo ? '初始化协作配置' : '跳过 Git，仅初始化协作'}
                  </span>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    {isGitRepo ? '已检测到 Git，仅需铺设协作规则。' : '无版本控制，时光回溯和代码审查功能将不可用。'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleSetup('skip')}
                  className="min-w-[6.5rem] px-4 py-2 rounded-lg bg-cocreator-primary hover:bg-cocreator-dark text-white text-xs font-medium transition-colors"
                >
                  {isGitRepo ? '初始化' : '跳过'}
                </button>
              </div>
            </div>

            {/* Explanation */}
            <p className="text-[10px] text-gray-400 px-1 mt-1">
              初始化将写入协作规则（CLAUDE.md 等）、Skills 链接和方法论模板。已有文件不会被覆盖。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
