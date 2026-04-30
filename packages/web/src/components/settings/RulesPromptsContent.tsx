'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface RuleFile {
  path: string;
  content: string;
  exists: boolean;
}

interface ProviderGuide extends RuleFile {
  provider: string;
}

interface RulesData {
  sharedRules: RuleFile[];
  providerGuides: ProviderGuide[];
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: '布偶猫 (Claude)',
  codex: '缅因猫 (Codex)',
  gemini: '暹罗猫 (Gemini)',
};

const FILE_LABELS: Record<string, string> = {
  'cat-cafe-skills/refs/shared-rules.md': '家规（三猫共用协作规则）',
  'docs/SOP.md': '运维 SOP',
};

export function RulesPromptsContent() {
  const [data, setData] = useState<RulesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/rules');
        if (cancelled) return;
        if (!res.ok) {
          setError('规则加载失败');
          return;
        }
        setData((await res.json()) as RulesData);
      } catch {
        if (!cancelled) setError('网络错误');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="console-status-chip" data-status="error">
        {error}
      </div>
    );
  }
  if (!data) return <p className="text-sm text-cafe-muted">加载中...</p>;

  const toggle = (path: string) => setExpandedFile((prev) => (prev === path ? null : path));

  return (
    <div className="space-y-6">
      <Section
        title="共享规则"
        description="全部成员遵循的协作规则和流程规范（shared-rules.md 摘要注入系统提示词，SOP.md 为参考文档）"
        badge={`${data.sharedRules.length} files`}
      >
        {data.sharedRules.map((file) => (
          <RuleFileCard
            key={file.path}
            file={file}
            expanded={expandedFile === file.path}
            onToggle={() => toggle(file.path)}
          />
        ))}
      </Section>

      <Section
        title="模型指南"
        description="每只猫的角色定义和模型特定约束"
        badge={`${data.providerGuides.length} guides`}
      >
        {data.providerGuides.map((guide) => (
          <RuleFileCard
            key={guide.path}
            file={guide}
            label={PROVIDER_LABELS[guide.provider]}
            expanded={expandedFile === guide.path}
            onToggle={() => toggle(guide.path)}
          />
        ))}
      </Section>
    </div>
  );
}

function Section({
  title,
  description,
  badge,
  children,
}: {
  title: string;
  description: string;
  badge: string;
  children: React.ReactNode;
}) {
  return (
    <section className="console-section-shell rounded-xl p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cafe-muted">Governance</p>
          <h3 className="text-lg font-semibold tracking-[-0.03em] text-cafe">{title}</h3>
          <p className="max-w-2xl text-sm leading-6 text-cafe-secondary">{description}</p>
        </div>
        <span className="console-pill inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold text-cafe-secondary">
          {badge}
        </span>
      </div>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

function RuleFileCard({
  file,
  label,
  expanded,
  onToggle,
}: {
  file: RuleFile;
  label?: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const displayLabel = label ?? FILE_LABELS[file.path] ?? file.path;

  if (!file.exists) {
    return (
      <div className="console-list-card rounded-xl px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-cafe">{displayLabel}</p>
          <span className="console-status-chip" data-status="error">
            文件不存在
          </span>
        </div>
        <p className="mt-2 text-xs text-cafe-muted">{file.path}</p>
      </div>
    );
  }

  const lineCount = file.content.split('\n').length;

  return (
    <div className="console-list-card rounded-xl overflow-hidden" data-active={expanded ? 'true' : 'false'}>
      <button onClick={onToggle} className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-cafe">{displayLabel}</p>
            <span className="console-status-chip" data-status="info">
              {expanded ? '已展开' : '可预览'}
            </span>
          </div>
          <p className="mt-1 text-xs text-cafe-muted">
            {file.path} · {lineCount} 行
          </p>
        </div>
        <span className="console-pill flex h-10 w-10 items-center justify-center rounded-full text-cafe-secondary">
          <svg
            className={`h-4 w-4 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </span>
      </button>
      {expanded && (
        <div className="console-code-pane">
          <pre className="max-h-[32rem] overflow-x-auto overflow-y-auto px-4 py-4 text-[12px] leading-6 text-cafe-secondary whitespace-pre-wrap">
            {file.content}
          </pre>
        </div>
      )}
    </div>
  );
}
