'use client';

import { useEffect, useRef, useState } from 'react';
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
    <section className="rounded-[20px] border border-[#F1E7DF] bg-[#FFFDFC] p-[18px]">
      <h3 className="text-[17px] font-bold text-[#2D2118]">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function PageIntro() {
  return (
    <section className="rounded-[20px] border border-[#F1E7DF] bg-[#FFFDFC] p-[18px]">
      <p className="text-[13px] font-semibold text-[#E29578]">系统配置 &gt; 环境 &amp; 文件</p>
      <p className="mt-2 text-[14px] leading-6 text-[#8A776B]">
        当前环境变量、配置文件、数据目录三段式不变。新增：变量值可直接编辑，保存后自动回填 .env。
      </p>
    </section>
  );
}

function VscodeLink({ path, label }: { path: string; label: string }) {
  return (
    <a
      href={`vscode://file${path}`}
      className="truncate text-xs font-semibold text-[#D49266] underline transition hover:text-[#C27D52]"
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

const RESTART_REQUIRED_ENV_VARS = new Set(['API_SERVER_PORT', 'PREVIEW_GATEWAY_PORT']);

function buildVariableHint(variable: EnvVar): string | null {
  const hints: string[] = [];
  if (RESTART_REQUIRED_ENV_VARS.has(variable.name)) {
    hints.push('写回 .env 后需重启相关服务生效。');
  }
  if (variable.maskMode === 'url') {
    hints.push('当前值已做凭证脱敏；修改时请填写完整连接串。');
  }
  return hints.length > 0 ? hints.join(' ') : null;
}

function isEditableVariable(variable: EnvVar): boolean {
  return variable.runtimeEditable !== false && !variable.sensitive;
}

function isMaskedUrlVariable(variable: EnvVar): boolean {
  return variable.maskMode === 'url' && typeof variable.currentValue === 'string' && variable.currentValue.includes('***');
}

function initialDraftValue(variable: EnvVar): string {
  if (isMaskedUrlVariable(variable)) return '';
  return variable.currentValue ?? '';
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
          <div key={f.name} className="flex items-baseline gap-2 rounded-[12px] border border-[#F3E8DE] bg-white px-3 py-2">
            <code className="shrink-0 rounded bg-[#F7F3F0] px-1.5 py-0.5 font-mono text-xs text-[#6A5A50]">{f.name}</code>
            <span className="text-xs text-[#8A776B]">{f.desc}</span>
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
      <div className="mb-3 rounded-[12px] border border-[#D7E9D7] bg-[#F6FBF6] px-3 py-2 text-xs leading-5 text-[#5B7A5C]">
        变量值可直接编辑，保存后自动回填 `.env`。写回 .env 后需重启相关服务生效；URL 型连接串当前值已脱敏，修改时请填写完整值。
      </div>
      <div className="space-y-3">
        {grouped.map((group) => (
          <div key={group.key}>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#77A777]">{group.label}</p>
            <div className="space-y-1">
              {group.vars.map((v) => (
                <div
                  key={v.name}
                  className="grid gap-2 rounded-[12px] border border-[#F3E8DE] bg-white px-3 py-2 text-xs md:grid-cols-[minmax(0,1fr)_220px]"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-baseline gap-1.5 min-w-0">
                      <code className="shrink-0 font-mono text-[#6A5A50]">{v.name}</code>
                      <span className="truncate text-[#B59A88]">{v.description}</span>
                    </div>
                    <div className="text-[11px] text-[#B59A88]">默认: {v.defaultValue}</div>
                    {!isEditableVariable(v) && (
                      <div className={`font-mono text-[11px] ${v.currentValue ? 'text-[#6A5A50]' : 'text-[#D4C5BA]'}`}>
                        {v.currentValue ?? '未设置'}
                      </div>
                    )}
                  </div>
                  {isEditableVariable(v) ? (
                    <div className="space-y-1">
                      <input
                        aria-label={v.name}
                        value={drafts[v.name] ?? ''}
                        onChange={(e) => onDraftChange(v.name, e.target.value)}
                        placeholder={isMaskedUrlVariable(v) ? '保持当前值（已脱敏）' : v.defaultValue}
                        className="rounded-[10px] border border-[#E8DCCF] bg-[#F7F3F0] px-3 py-2 font-mono text-xs text-[#6A5A50]"
                      />
                      {buildVariableHint(v) ? (
                        <div className="text-[11px] leading-5 text-[#B59A88]">{buildVariableHint(v)}</div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="rounded-[10px] border border-dashed border-[#E8DCCF] bg-[#F7F3F0] px-3 py-2 text-[11px] text-[#8A776B]">
                      只读变量（认证凭证 / 仅启动期生效）
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
          className="rounded-full bg-[#D49266] px-4 py-2 text-xs font-semibold text-white hover:bg-[#c47f52] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saveState.saving ? '保存中...' : '保存到 .env'}
        </button>
        {saveState.error && <span className="text-xs text-red-600">{saveState.error}</span>}
        {saveState.success && <span className="text-xs text-green-600">{saveState.success}</span>}
      </div>
    </Section>
  );
}

function ChangesNote() {
  return (
    <section className="rounded-[16px] border border-[#E8C9AF] bg-[#FFF4EC] px-[14px] py-[14px]">
      <p className="text-[13px] font-bold text-[#C8946B]">F127 变化说明</p>
      <p className="mt-1 text-[13px] leading-6 text-[#8A776B]">
        1. 环境变量从只读改为可编辑
        <br />
        2. 保存后自动回填 .env 文件
        <br />
        3. 敏感变量继续 masked 显示
        <br />
        4. 配置文件和数据目录保持只读不变
        <br />
        5. 认证凭证（API Key 等）不在此处管理，统一走「账号配置」
      </p>
    </section>
  );
}

function DataDirsSection({ dataDirs }: { dataDirs: DataDirs }) {
  const dirs = buildDataDirs(dataDirs);
  return (
    <Section title="数据目录">
      <div className="space-y-2">
        {dirs.map((d) => (
          <div key={d.name} className="flex items-baseline gap-2 rounded-[12px] border border-[#F3E8DE] bg-white px-3 py-2">
            <span className="shrink-0 text-xs font-medium text-[#6A5A50]">{d.name}</span>
            <span className="text-xs text-[#8A776B]">{d.desc}</span>
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
  const saveLockRef = useRef(false);
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
              body.variables.filter(isEditableVariable).map((variable) => [variable.name, initialDraftValue(variable)]),
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
      baselineValue: initialDraftValue(variable),
      maskedUrl: isMaskedUrlVariable(variable),
    }))
    .filter((variable) => variable.value !== variable.baselineValue)
    .filter((variable) => !variable.maskedUrl || variable.value.trim().length > 0)
    .map(({ name, value }) => ({ name, value }));

  const isDirty = changedUpdates.length > 0;

  const handleDraftChange = (name: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [name]: value }));
    setSaveState((prev) => ({ ...prev, error: null, success: null }));
  };

  const handleSave = async () => {
    if (saveLockRef.current) return;
    if (!isDirty) {
      setSaveState({ saving: false, error: null, success: '当前没有待写回的变更' });
      return;
    }
    saveLockRef.current = true;
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
      setData((prev) => (prev ? { ...prev, variables: nextVariables } : prev));
      setDrafts(
        Object.fromEntries(
          nextVariables.filter(isEditableVariable).map((variable) => [variable.name, initialDraftValue(variable)]),
        ),
      );
      setSaveState({ saving: false, error: null, success: '已写回 .env 并刷新摘要；部分变量需重启相关服务生效' });
    } catch {
      setSaveState({ saving: false, error: '保存失败', success: null });
    } finally {
      saveLockRef.current = false;
    }
  };

  return (
    <div className="space-y-4">
      <PageIntro />
      <EnvVarsSection
        categories={data.categories}
        variables={data.variables}
        drafts={drafts}
        isDirty={isDirty}
        saveState={saveState}
        onDraftChange={handleDraftChange}
        onSave={handleSave}
      />
      <ConfigFilesSection projectRoot={data.paths.projectRoot} />
      <DataDirsSection dataDirs={data.paths.dataDirs} />
      <ChangesNote />
    </div>
  );
}
