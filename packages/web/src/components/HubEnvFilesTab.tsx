'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface EnvVar {
  name: string;
  defaultValue: string;
  description: string;
  category: string;
  sensitive: boolean;
  maskMode?: 'url';
  runtimeEditable?: boolean;
  currentValue: string | null;
}

interface DataDirs {
  auditLogs: string;
  cliArchive: string;
  redisDevSandbox: string;
  uploads: string;
}

interface EnvPaths {
  projectRoot: string;
  homeDir: string;
  dataDirs: DataDirs;
}

interface EnvSummaryData {
  categories: Record<string, string>;
  variables: EnvVar[];
  paths: EnvPaths;
}

interface EnvSaveResponse {
  ok: boolean;
  envFilePath?: string;
  summary?: EnvVar[];
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-gray-200 bg-gray-50/70 p-3">
      <h3 className="text-xs font-semibold text-gray-700 mb-2">{title}</h3>
      {children}
    </section>
  );
}

function VscodeLink({ path, label }: { path: string; label: string }) {
  return (
    <a
      href={`vscode://file${path}`}
      className="text-blue-600 hover:text-blue-800 underline text-xs truncate block"
      title={path}
    >
      {label}
    </a>
  );
}

function buildConfigFiles(projectRoot: string) {
  return [
    { name: 'cat-template.json', path: `${projectRoot}/cat-template.json`, desc: '猫猫模板（只读 seed）' },
    { name: '.cat-cafe/cat-catalog.json', path: `${projectRoot}/.cat-cafe/cat-catalog.json`, desc: '运行时成员真相源' },
    { name: '.env', path: `${projectRoot}/.env`, desc: '可编辑环境变量真相源（不含认证凭证）' },
    { name: 'start-dev.sh', path: `${projectRoot}/scripts/start-dev.sh`, desc: '开发启动脚本' },
    { name: 'CLAUDE.md', path: `${projectRoot}/CLAUDE.md`, desc: '布偶猫项目指引' },
    { name: 'AGENTS.md', path: `${projectRoot}/AGENTS.md`, desc: '缅因猫项目指引' },
    { name: 'GEMINI.md', path: `${projectRoot}/GEMINI.md`, desc: '暹罗猫项目指引' },
  ];
}

function isEditableVariable(variable: EnvVar): boolean {
  return variable.runtimeEditable !== false && !variable.sensitive && variable.maskMode !== 'url';
}

function buildDataDirs(dataDirs: DataDirs) {
  return [
    { name: '审计日志', path: dataDirs.auditLogs, desc: 'EventAuditLog 输出' },
    { name: 'CLI 归档', path: dataDirs.cliArchive, desc: 'CLI 原始输出归档' },
    { name: 'Redis 开发沙盒', path: dataDirs.redisDevSandbox, desc: '开发用 Redis 数据' },
    { name: '上传目录', path: dataDirs.uploads, desc: '文件上传存储' },
  ];
}

function ConfigFilesSection({ projectRoot }: { projectRoot: string }) {
  const files = buildConfigFiles(projectRoot);
  return (
    <Section title="配置文件">
      <div className="space-y-2">
        {files.map((f) => (
          <div key={f.name} className="flex items-baseline gap-2">
            <code className="text-xs font-mono text-gray-700 bg-gray-200 px-1.5 py-0.5 rounded shrink-0">{f.name}</code>
            <span className="text-xs text-gray-500">{f.desc}</span>
            <VscodeLink path={f.path} label="打开" />
          </div>
        ))}
      </div>
    </Section>
  );
}

function EnvVarsSection({
  categories,
  variables,
  drafts,
  isDirty,
  saveState,
  onDraftChange,
  onSave,
}: {
  categories: Record<string, string>;
  variables: EnvVar[];
  drafts: Record<string, string>;
  isDirty: boolean;
  saveState: { saving: boolean; error: string | null; success: string | null };
  onDraftChange: (name: string, value: string) => void;
  onSave: () => void;
}) {
  const grouped = Object.entries(categories)
    .map(([key, label]) => ({
      key,
      label,
      vars: variables.filter((v) => v.category === key),
    }))
    .filter((g) => g.vars.length > 0);

  return (
    <Section title="环境变量">
      <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        Hub 只允许编辑非敏感且支持热生效的运行参数；认证凭证、带凭据 URL、启动期变量保持只读，保存后会自动回填 `.env`。
      </div>
      <div className="space-y-3">
        {grouped.map((group) => (
          <div key={group.key}>
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{group.label}</p>
            <div className="space-y-1">
              {group.vars.map((v) => (
                <div key={v.name} className="grid gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs md:grid-cols-[minmax(0,1fr)_220px]">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-baseline gap-1.5 min-w-0">
                      <code className="font-mono text-gray-700 shrink-0">{v.name}</code>
                      <span className="text-gray-400 truncate">{v.description}</span>
                    </div>
                    <div className="text-[11px] text-gray-400">默认: {v.defaultValue}</div>
                    {!isEditableVariable(v) && (
                      <div className={`font-mono text-[11px] ${v.currentValue ? 'text-gray-600' : 'text-gray-300'}`}>
                        {v.currentValue ?? '未设置'}
                      </div>
                    )}
                  </div>
                  {isEditableVariable(v) ? (
                    <input
                      aria-label={v.name}
                      value={drafts[v.name] ?? ''}
                      onChange={(e) => onDraftChange(v.name, e.target.value)}
                      placeholder={v.defaultValue}
                      className="rounded border border-gray-200 bg-white px-2 py-1.5 font-mono text-xs text-gray-700"
                    />
                  ) : (
                    <div className="rounded border border-dashed border-gray-200 bg-gray-50 px-2 py-1.5 text-[11px] text-gray-500">
                      只读变量（认证凭证 / 带凭据 URL / 启动期参数）
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={!isDirty || saveState.saving}
          className="rounded bg-[#D49266] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#c47f52] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saveState.saving ? '保存中...' : '保存到 .env'}
        </button>
        {saveState.error && <span className="text-xs text-red-600">{saveState.error}</span>}
        {saveState.success && <span className="text-xs text-green-600">{saveState.success}</span>}
      </div>
    </Section>
  );
}

function DataDirsSection({ dataDirs }: { dataDirs: DataDirs }) {
  const dirs = buildDataDirs(dataDirs);
  return (
    <Section title="数据目录">
      <div className="space-y-2">
        {dirs.map((d) => (
          <div key={d.name} className="flex items-baseline gap-2">
            <span className="text-xs text-gray-700 font-medium shrink-0">{d.name}</span>
            <span className="text-xs text-gray-500">{d.desc}</span>
            <VscodeLink path={d.path} label="打开" />
          </div>
        ))}
      </div>
    </Section>
  );
}

export function HubEnvFilesTab() {
  const [data, setData] = useState<EnvSummaryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<{ saving: boolean; error: string | null; success: string | null }>({
    saving: false,
    error: null,
    success: null,
  });

  useEffect(() => {
    apiFetch('/api/config/env-summary')
      .then(async (res) => {
        if (res.ok) {
          const body = (await res.json()) as EnvSummaryData;
          setData(body);
          setDrafts(
            Object.fromEntries(
              body.variables.filter(isEditableVariable).map((variable) => [variable.name, variable.currentValue ?? '']),
            ),
          );
        } else {
          setError('环境信息加载失败');
        }
      })
      .catch(() => setError('环境信息加载失败'));
  }, []);

  if (error) return <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{error}</p>;
  if (!data) return <p className="text-sm text-gray-400">加载中...</p>;

  const editableVariables = data.variables.filter(isEditableVariable);
  const changedUpdates = editableVariables
    .map((variable) => ({
      name: variable.name,
      value: drafts[variable.name] ?? '',
      currentValue: variable.currentValue ?? '',
    }))
    .filter((variable) => variable.value !== variable.currentValue)
    .map(({ name, value }) => ({ name, value }));

  const isDirty = changedUpdates.length > 0;

  const handleDraftChange = (name: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [name]: value }));
    setSaveState((prev) => ({ ...prev, error: null, success: null }));
  };

  const handleSave = async () => {
    if (!isDirty) {
      setSaveState({ saving: false, error: null, success: '当前没有待写回的变更' });
      return;
    }
    setSaveState({ saving: true, error: null, success: null });
    try {
      const res = await apiFetch('/api/config/env', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: changedUpdates }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<EnvSaveResponse> & { error?: string };
      if (!res.ok) {
        setSaveState({ saving: false, error: body.error ?? '保存失败', success: null });
        return;
      }
      const nextVariables = Array.isArray(body.summary)
        ? body.summary
        : data.variables.map((variable) => {
            const update = changedUpdates.find((item) => item.name === variable.name);
            if (!update) return variable;
            return { ...variable, currentValue: update.value || null };
          });
      setData({ ...data, variables: nextVariables });
      setDrafts(
        Object.fromEntries(
          nextVariables.filter(isEditableVariable).map((variable) => [variable.name, variable.currentValue ?? '']),
        ),
      );
      setSaveState({ saving: false, error: null, success: '已写回 .env 并刷新摘要' });
    } catch {
      setSaveState({ saving: false, error: '保存失败', success: null });
    }
  };

  return (
    <>
      <ConfigFilesSection projectRoot={data.paths.projectRoot} />
      <EnvVarsSection
        categories={data.categories}
        variables={data.variables}
        drafts={drafts}
        isDirty={isDirty}
        saveState={saveState}
        onDraftChange={handleDraftChange}
        onSave={handleSave}
      />
      <DataDirsSection dataDirs={data.paths.dataDirs} />
    </>
  );
}
