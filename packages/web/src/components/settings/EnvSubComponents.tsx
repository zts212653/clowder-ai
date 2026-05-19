'use client';

import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import {
  SettingsBadge,
  SettingsBreadcrumb,
  SettingsCodeField,
  SettingsCodeLabel,
  SettingsCollapsibleCard,
  SettingsHubLink,
  SettingsInlineItem,
  SettingsPrimaryButton,
  SettingsReadOnlyField,
  SettingsSection,
  SettingsStatusStrip,
  SettingsText,
  SettingsVarRow,
} from './primitives';

export interface EnvVar {
  name: string;
  defaultValue: string;
  description: string;
  category: string;
  sensitive: boolean;
  maskMode?: 'url';
  runtimeEditable?: boolean;
  deprecated?: string;
  allowedValues?: string[];
  currentValue: string | null;
}

export interface DataDirs {
  auditLogs: string;
  runtimeLogs: string;
  cliArchive: string;
  redisDevSandbox: string;
  uploads: string;
}

export interface EnvPaths {
  projectRoot: string;
  homeDir: string;
  dataDirs: DataDirs;
}

export interface EnvSummaryData {
  categories: Record<string, string>;
  variables: EnvVar[];
  paths: EnvPaths;
}

export interface EnvSaveResponse {
  ok: boolean;
  envFilePath?: string;
  summary?: EnvVar[];
}

const DENYLIST_PATTERNS = [/^\.env/, /\.pem$/, /\.key$/, /^id_rsa/];

function isInsideProject(absPath: string, projectRoot: string): boolean {
  return absPath.startsWith(`${projectRoot}/`) || absPath === projectRoot;
}

function isDenylisted(fileName: string): boolean {
  return DENYLIST_PATTERNS.some((p) => p.test(fileName));
}

function toRelativePath(absPath: string, projectRoot: string): string {
  if (absPath.startsWith(`${projectRoot}/`)) return absPath.slice(projectRoot.length + 1);
  return absPath;
}

type PathKind = 'file' | 'dir-inside' | 'denied' | 'outside';

function classifyPath(absPath: string, projectRoot: string, isDir: boolean): { kind: PathKind; relPath: string } {
  if (!isInsideProject(absPath, projectRoot)) {
    return { kind: 'outside', relPath: absPath };
  }
  const relPath = toRelativePath(absPath, projectRoot);
  const fileName = relPath.split('/').pop() ?? relPath;
  if (!isDir && isDenylisted(fileName)) {
    return { kind: 'denied', relPath };
  }
  return { kind: isDir ? 'dir-inside' : 'file', relPath };
}

const RESTART_REQUIRED_ENV_VARS = new Set(['API_SERVER_PORT', 'PREVIEW_GATEWAY_PORT']);

function needsRestart(variable: EnvVar): boolean {
  return variable.runtimeEditable === false || RESTART_REQUIRED_ENV_VARS.has(variable.name);
}

function buildVariableHint(variable: EnvVar): string | null {
  const hints: string[] = [];
  if (needsRestart(variable)) hints.push('写回 .env 后需重启相关服务生效。');
  if (variable.maskMode === 'url') hints.push('当前值已做凭证脱敏；修改时请填写完整连接串。');
  return hints.length > 0 ? hints.join(' ') : null;
}

export function isEditableVariable(variable: EnvVar): boolean {
  if (variable.runtimeEditable === true) return true;
  if (variable.runtimeEditable === false) return false;
  return !variable.sensitive;
}

export function isSensitiveEditable(variable: EnvVar): boolean {
  return variable.sensitive && variable.runtimeEditable === true;
}

export function isMaskedUrlVariable(variable: EnvVar): boolean {
  return (
    variable.maskMode === 'url' && typeof variable.currentValue === 'string' && variable.currentValue.includes('***')
  );
}

export function initialDraftValue(variable: EnvVar): string {
  if (isSensitiveEditable(variable)) return '';
  if (isMaskedUrlVariable(variable)) return '';
  return variable.currentValue ?? '';
}

export function PageIntro() {
  return (
    <div style={{ paddingInline: '0.25rem' }}>
      <SettingsBreadcrumb segments={[{ label: '系统配置' }, { label: '环境 & 文件' }]} />
      <SettingsText as="p" variant="sm" tone="secondary" className="mt-2 leading-6">
        当前环境变量、配置文件、数据目录三段式不变。新增：变量值可直接编辑，保存后自动回填 .env。
      </SettingsText>
    </div>
  );
}

function HubFileLink({ relPath, label }: { relPath: string; label: string }) {
  const setOpenFile = useChatStore((s) => s.setWorkspaceOpenFile);
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setOpenFile(relPath, null, null);
    },
    [setOpenFile, relPath],
  );
  return (
    <SettingsHubLink onClick={handleClick} title={`在 Hub 工作区中查看\n${relPath}`}>
      {label}
    </SettingsHubLink>
  );
}

function HubDirLink({ relPath, label }: { relPath: string; label: string }) {
  const setRevealPath = useChatStore((s) => s.setWorkspaceRevealPath);
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setRevealPath(relPath);
    },
    [setRevealPath, relPath],
  );
  return (
    <SettingsHubLink onClick={handleClick} title={`打开工作区面板，在文件树中找到:\n${relPath}`}>
      {label}
    </SettingsHubLink>
  );
}

function RestrictedPathLabel({ absPath, reason }: { absPath: string; reason: string }) {
  return (
    <SettingsText tone="muted" className="shrink-0 cursor-default" title={`${reason}\n${absPath}`}>
      受保护
    </SettingsText>
  );
}

function PathAction({
  classification,
  absPath,
}: {
  classification: { kind: PathKind; relPath: string };
  absPath: string;
}) {
  switch (classification.kind) {
    case 'file':
      return <HubFileLink relPath={classification.relPath} label="在 Hub 中查看" />;
    case 'dir-inside':
      return <HubDirLink relPath={classification.relPath} label="在 Hub 中查看" />;
    case 'denied':
      return <RestrictedPathLabel absPath={absPath} reason="受安全策略保护，无法在 Hub 中打开" />;
    case 'outside':
      return <RestrictedPathLabel absPath={absPath} reason="位于项目目录外部，无法在 Hub 中打开" />;
  }
}

function buildConfigFiles(projectRoot: string) {
  return [
    {
      name: 'cat-template.json',
      path: `${projectRoot}/cat-template.json`,
      desc: '猫猫模板（只读 seed）',
      isDir: false,
    },
    {
      name: '.cat-cafe/cat-catalog.json',
      path: `${projectRoot}/.cat-cafe/cat-catalog.json`,
      desc: '运行时成员真相源',
      isDir: false,
    },
    { name: '.env', path: `${projectRoot}/.env`, desc: '可编辑环境变量真相源（不含认证凭证）', isDir: false },
    { name: '.env.local', path: `${projectRoot}/.env.local`, desc: '本地环境变量覆盖', isDir: false },
    { name: 'start-dev.sh', path: `${projectRoot}/scripts/start-dev.sh`, desc: '开发启动脚本', isDir: false },
    { name: 'CLAUDE.md', path: `${projectRoot}/CLAUDE.md`, desc: '布偶猫项目指引', isDir: false },
    { name: 'AGENTS.md', path: `${projectRoot}/AGENTS.md`, desc: '缅因猫项目指引', isDir: false },
    { name: 'GEMINI.md', path: `${projectRoot}/GEMINI.md`, desc: '暹罗猫项目指引', isDir: false },
  ];
}

function buildDataDirs(dataDirs: DataDirs) {
  return [
    { name: '审计日志', path: dataDirs.auditLogs, desc: 'EventAuditLog 输出', isDir: true },
    { name: '运行日志', path: dataDirs.runtimeLogs, desc: 'Pino 结构化 runtime log', isDir: true },
    { name: 'CLI 归档', path: dataDirs.cliArchive, desc: 'CLI 原始输出归档', isDir: true },
    { name: 'Redis 开发沙盒', path: dataDirs.redisDevSandbox, desc: '开发用 Redis 数据', isDir: true },
    { name: '上传目录', path: dataDirs.uploads, desc: '文件上传存储', isDir: true },
  ];
}

export function ConfigFilesSection({ projectRoot }: { projectRoot: string }) {
  const files = useMemo(() => buildConfigFiles(projectRoot), [projectRoot]);
  return (
    <SettingsSection title="配置文件">
      <div className="space-y-2">
        {files.map((f) => {
          const cls = classifyPath(f.path, projectRoot, f.isDir);
          return (
            <SettingsInlineItem key={f.name}>
              <SettingsCodeLabel>{f.name}</SettingsCodeLabel>
              <SettingsText tone="secondary">{f.desc}</SettingsText>
              <PathAction classification={cls} absPath={f.path} />
            </SettingsInlineItem>
          );
        })}
      </div>
    </SettingsSection>
  );
}

function EnvCategoryGroup({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <SettingsCollapsibleCard title={label} count={count} collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)}>
      {children}
    </SettingsCollapsibleCard>
  );
}

export function EnvVarsSection({
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
    .map(([key, label]) => ({ key, label, vars: variables.filter((v) => v.category === key) }))
    .filter((g) => g.vars.length > 0);

  const pendingRestartCount = variables.filter(
    (v) => needsRestart(v) && drafts[v.name] !== undefined && drafts[v.name] !== initialDraftValue(v),
  ).length;

  return (
    <SettingsSection title="环境变量">
      <SettingsStatusStrip tone="success">
        变量值可直接编辑，保存后自动回填 `.env`。URL 型连接串当前值已脱敏，修改时请填写完整值。
      </SettingsStatusStrip>
      <div className="mt-3 space-y-3">
        {grouped.map((group) => (
          <EnvCategoryGroup key={group.key} label={group.label} count={group.vars.length}>
            {group.vars.map((v) => (
              <SettingsVarRow key={v.name}>
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <SettingsText
                      variant="micro"
                      tone={needsRestart(v) ? 'amber' : 'emerald'}
                      className="shrink-0"
                      title={needsRestart(v) ? '需重启生效' : '即时生效'}
                    >
                      {v.deprecated ? '⛔' : needsRestart(v) ? '🟡' : '🟢'}
                    </SettingsText>
                    <SettingsText as="code" tone="secondary" className="shrink-0 font-mono">
                      {v.name}
                    </SettingsText>
                    <SettingsText tone="muted" className="truncate">
                      {v.description}
                    </SettingsText>
                    {v.deprecated && (
                      <SettingsBadge tone="red" size="xxs">
                        已废弃
                      </SettingsBadge>
                    )}
                  </div>
                  <SettingsText as="div" tone="muted">
                    默认: {v.defaultValue}
                  </SettingsText>
                  {!isEditableVariable(v) && (
                    <SettingsText as="div" tone={v.currentValue ? 'secondary' : 'muted'} className="font-mono">
                      {v.currentValue ?? '未设置'}
                    </SettingsText>
                  )}
                </div>
                {isEditableVariable(v) ? (
                  <div className="space-y-1">
                    <SettingsCodeField
                      aria-label={v.name}
                      type={isSensitiveEditable(v) ? 'password' : 'text'}
                      autoComplete={isSensitiveEditable(v) ? 'off' : undefined}
                      value={drafts[v.name] ?? ''}
                      onChange={(e) => onDraftChange(v.name, e.target.value)}
                      placeholder={
                        isSensitiveEditable(v)
                          ? v.currentValue
                            ? '已设置（留空不修改）'
                            : '输入密钥'
                          : isMaskedUrlVariable(v)
                            ? '保持当前值（已脱敏）'
                            : v.defaultValue
                      }
                    />
                    {buildVariableHint(v) ? (
                      <SettingsText as="div" tone="muted" className="leading-5">
                        {buildVariableHint(v)}
                      </SettingsText>
                    ) : null}
                  </div>
                ) : (
                  <SettingsReadOnlyField>只读变量（认证凭证 / 仅启动期生效）</SettingsReadOnlyField>
                )}
              </SettingsVarRow>
            ))}
          </EnvCategoryGroup>
        ))}
      </div>
      {pendingRestartCount > 0 && (
        <SettingsStatusStrip tone="warn">{pendingRestartCount} 项变更需要重启生效</SettingsStatusStrip>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <SettingsPrimaryButton onClick={onSave} disabled={!isDirty || saveState.saving}>
          {saveState.saving ? '保存中...' : '保存到 .env'}
        </SettingsPrimaryButton>
        {saveState.error && <SettingsStatusStrip tone="error">{saveState.error}</SettingsStatusStrip>}
        {saveState.success && <SettingsStatusStrip tone="success">{saveState.success}</SettingsStatusStrip>}
      </div>
    </SettingsSection>
  );
}

export function DataDirsSection({ dataDirs, projectRoot }: { dataDirs: DataDirs; projectRoot: string }) {
  const dirs = useMemo(() => buildDataDirs(dataDirs), [dataDirs]);
  return (
    <SettingsSection title="数据目录">
      <div className="space-y-2">
        {dirs.map((d) => {
          const cls = classifyPath(d.path, projectRoot, d.isDir);
          return (
            <SettingsInlineItem key={d.name}>
              <SettingsText tone="secondary" className="shrink-0 font-medium">
                {d.name}
              </SettingsText>
              <SettingsText tone="secondary">{d.desc}</SettingsText>
              <PathAction classification={cls} absPath={d.path} />
            </SettingsInlineItem>
          );
        })}
      </div>
    </SettingsSection>
  );
}
