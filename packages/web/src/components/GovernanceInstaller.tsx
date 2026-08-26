'use client';

import type { BootstrapAction, BootstrapReport, GovernanceProvider, GovernanceSelection } from '@cat-cafe/shared';
import { useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface GovernanceInstallerProps {
  projectPath: string;
  recommendedProjectGuide?: boolean;
  allowCleanup?: boolean;
  onChanged?: () => void | Promise<void>;
}

type Operation = 'install' | 'cleanup';
type Phase = 'idle' | 'loading' | 'preview' | 'done' | 'error';

const PROVIDERS: readonly GovernanceProvider[] = ['claude', 'codex', 'gemini', 'kimi'];
const ACTION_LABEL: Record<BootstrapAction['action'], string> = {
  created: '将创建',
  updated: '将更新',
  skipped: '已跳过',
  symlinked: '将链接',
  deleted: '将删除',
};

function toggleValue<T extends string>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function parseSkillIds(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function operationEndpoint(operation: Operation): string {
  return operation === 'install' ? '/api/governance/confirm' : '/api/governance/cleanup';
}

function successMessage(report: BootstrapReport, operation: Operation, dryRun: boolean): string {
  if (!dryRun) return operation === 'install' ? '已按预览写入。' : '已按预览撤销。';
  return report.actions.length > 0 ? '请核对下面的精确改动。' : '当前选择没有可执行改动。';
}

async function postGovernanceOperation(
  projectPath: string,
  operation: Operation,
  dryRun: boolean,
  selection: GovernanceSelection,
  preview: BootstrapReport | null,
): Promise<{ report: BootstrapReport; conflict: boolean }> {
  const res = await apiFetch(operationEndpoint(operation), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectPath,
      dryRun,
      ...(operation === 'install' ? { selection } : {}),
      ...(!dryRun && preview ? { expectedPreviewChecksum: preview.previewChecksum } : {}),
    }),
  });
  const data = (await res.json()) as { report?: BootstrapReport; error?: string };
  if (!data.report) throw new Error(data.error ?? '治理操作没有返回预览');
  if (!res.ok && res.status !== 409) throw new Error(data.error ?? '治理操作失败');
  return { report: data.report, conflict: res.status === 409 };
}

export function GovernanceInstaller({
  projectPath,
  recommendedProjectGuide = false,
  allowCleanup = false,
  onChanged,
}: GovernanceInstallerProps) {
  const [guideEnabled, setGuideEnabled] = useState(recommendedProjectGuide);
  const [thinEntrypoints, setThinEntrypoints] = useState<readonly ('claude' | 'gemini')[]>([]);
  const [skillsEnabled, setSkillsEnabled] = useState(false);
  const [skillIds, setSkillIds] = useState('');
  const [providers, setProviders] = useState<readonly GovernanceProvider[]>([]);
  const [docsEnabled, setDocsEnabled] = useState(false);
  const [operation, setOperation] = useState<Operation>('install');
  const [phase, setPhase] = useState<Phase>('idle');
  const [report, setReport] = useState<BootstrapReport | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const selection = useMemo<GovernanceSelection>(
    () => ({
      ...(guideEnabled ? { projectGuide: { thinEntrypoints } } : {}),
      ...(skillsEnabled ? { projectSkills: { skillIds: parseSkillIds(skillIds), providers } } : {}),
      ...(docsEnabled ? { docsLifecycle: true } : {}),
    }),
    [docsEnabled, guideEnabled, providers, skillIds, skillsEnabled, thinEntrypoints],
  );

  const invalidatePreview = () => {
    setReport(null);
    setPhase('idle');
    setMessage(null);
  };

  const request = async (nextOperation: Operation, dryRun: boolean) => {
    setOperation(nextOperation);
    setPhase('loading');
    setMessage(null);
    try {
      const result = await postGovernanceOperation(projectPath, nextOperation, dryRun, selection, report);
      setReport(result.report);
      if (result.conflict) {
        setPhase('preview');
        setMessage('项目状态已变化，请重新确认最新预览。');
        return;
      }
      setPhase(dryRun ? 'preview' : 'done');
      setMessage(successMessage(result.report, nextOperation, dryRun));
      if (!dryRun) await onChanged?.();
    } catch (error) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : '治理操作失败');
    }
  };

  const mutatingActions = report?.actions.filter((action) => action.action !== 'skipped') ?? [];

  return (
    <section
      className="rounded-xl border border-cafe-subtle bg-cafe-surface-elevated p-4"
      data-testid="governance-installer"
    >
      <div>
        <h4 className="text-sm font-semibold text-cafe-black">可选项目治理</h4>
        <p className="mt-1 text-xs text-cafe-muted">
          猫猫已经可以在这个项目工作。先预览精确动作，只有确认后才写入；已有文件不会覆盖。
        </p>
      </div>

      <div className="mt-4 space-y-3">
        <label className="flex items-start gap-2 text-sm text-cafe-secondary">
          <input
            data-testid="governance-group-project-guide"
            type="checkbox"
            checked={guideEnabled}
            onChange={(event) => {
              invalidatePreview();
              setGuideEnabled(event.target.checked);
            }}
          />
          <span>
            <strong>项目指南</strong>
            <span className="block text-xs text-cafe-muted">生成 canonical AGENTS.md</span>
          </span>
        </label>
        {guideEnabled && (
          <div className="ml-6 flex flex-wrap gap-3 text-xs text-cafe-secondary">
            {(['claude', 'gemini'] as const).map((provider) => (
              <label key={provider} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={thinEntrypoints.includes(provider)}
                  onChange={() => {
                    invalidatePreview();
                    setThinEntrypoints(toggleValue(thinEntrypoints, provider));
                  }}
                />
                {provider === 'claude' ? 'CLAUDE.md 薄入口' : 'GEMINI.md 薄入口'}
              </label>
            ))}
          </div>
        )}

        <label className="flex items-start gap-2 text-sm text-cafe-secondary">
          <input
            type="checkbox"
            checked={skillsEnabled}
            onChange={(event) => {
              invalidatePreview();
              setSkillsEnabled(event.target.checked);
            }}
          />
          <span>
            <strong>项目 Skills</strong>
            <span className="block text-xs text-cafe-muted">只链接点名的 Skill 与 provider</span>
          </span>
        </label>
        {skillsEnabled && (
          <div className="ml-6 space-y-2">
            <input
              aria-label="Skill IDs"
              value={skillIds}
              onChange={(event) => {
                invalidatePreview();
                setSkillIds(event.target.value);
              }}
              placeholder="tdd, worktree"
              className="w-full rounded-lg border border-cafe-subtle bg-cafe-surface-canvas px-3 py-2 text-xs"
            />
            <div className="flex flex-wrap gap-3 text-xs text-cafe-secondary">
              {PROVIDERS.map((provider) => (
                <label key={provider} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={providers.includes(provider)}
                    onChange={() => {
                      invalidatePreview();
                      setProviders(toggleValue(providers, provider));
                    }}
                  />
                  {provider}
                </label>
              ))}
            </div>
          </div>
        )}

        <label className="flex items-start gap-2 text-sm text-cafe-secondary">
          <input
            type="checkbox"
            checked={docsEnabled}
            onChange={(event) => {
              invalidatePreview();
              setDocsEnabled(event.target.checked);
            }}
          />
          <span>
            <strong>文档生命周期模板</strong>
            <span className="block text-xs text-cafe-muted">SOP、BACKLOG 与 feature 模板；默认不生成</span>
          </span>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void request('install', true)}
          disabled={phase === 'loading'}
          className="rounded-lg bg-cafe-accent px-3 py-1.5 text-xs font-semibold text-[var(--cafe-surface)] disabled:opacity-50"
        >
          {phase === 'loading' && operation === 'install' ? '预览中...' : '预览改动'}
        </button>
        {allowCleanup && (
          <button
            type="button"
            onClick={() => void request('cleanup', true)}
            disabled={phase === 'loading'}
            className="rounded-lg border border-cafe-subtle px-3 py-1.5 text-xs font-semibold text-cafe-secondary disabled:opacity-50"
          >
            预览撤销
          </button>
        )}
      </div>

      {message && (
        <p className={`mt-3 text-xs ${phase === 'error' ? 'text-conn-red-text' : 'text-cafe-secondary'}`}>{message}</p>
      )}
      {report && (
        <div className="mt-3 space-y-2">
          <ul className="max-h-56 space-y-1 overflow-y-auto text-xs">
            {report.actions.map((action) => (
              <li
                key={`${action.action}:${action.file}`}
                className="rounded-lg border border-cafe-subtle bg-cafe-surface-canvas px-2.5 py-2"
              >
                <span className="font-semibold text-cafe-secondary">{ACTION_LABEL[action.action]}</span>{' '}
                <code className="break-all">{action.file}</code>
                <span className="block text-cafe-muted">{action.reason}</span>
              </li>
            ))}
          </ul>
          {phase === 'preview' && mutatingActions.length > 0 && (
            <button
              type="button"
              onClick={() => void request(operation, false)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-[var(--cafe-surface)] ${operation === 'cleanup' ? 'bg-conn-red-text' : 'bg-cafe-accent'}`}
            >
              {operation === 'cleanup'
                ? `确认撤销 ${mutatingActions.length} 项`
                : `确认写入 ${mutatingActions.length} 项`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
