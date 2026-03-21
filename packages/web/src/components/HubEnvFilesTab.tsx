'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

interface EnvVar {
  name: string;
  defaultValue: string;
  description: string;
  category: string;
  sensitive: boolean;
  currentValue: string | null;
}

interface DataDirs {
  auditLogs: string;
  runtimeLogs: string;
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

// Must stay in sync with workspace-security.ts DENYLIST_PATTERNS
const DENYLIST_PATTERNS = [/^\.env/, /\.pem$/, /\.key$/, /^id_rsa/];

function isInsideProject(absPath: string, projectRoot: string): boolean {
  return absPath.startsWith(projectRoot + '/') || absPath === projectRoot;
}

function isDenylisted(fileName: string): boolean {
  return DENYLIST_PATTERNS.some((p) => p.test(fileName));
}

function toRelativePath(absPath: string, projectRoot: string): string {
  if (absPath.startsWith(projectRoot + '/')) return absPath.slice(projectRoot.length + 1);
  return absPath;
}

type PathKind = 'file' | 'dir-inside' | 'denied' | 'outside';

/**
 * Classify a path for Hub navigation. Returns kind + relPath.
 * - file: openable via setWorkspaceOpenFile
 * - dir-inside: directory in worktree, opens workspace panel only
 * - denied: blocked by security denylist
 * - outside: not within worktree root
 */
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-gray-200 bg-gray-50/70 p-3">
      <h3 className="text-xs font-semibold text-gray-700 mb-2">{title}</h3>
      {children}
    </section>
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
    <button
      type="button"
      onClick={handleClick}
      className="text-blue-600 hover:text-blue-800 text-xs shrink-0 underline underline-offset-2 decoration-blue-300/60 hover:decoration-blue-600 transition-colors"
      title={`在 Hub 工作区中查看\n${relPath}`}
    >
      {label}
    </button>
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
    <button
      type="button"
      onClick={handleClick}
      className="text-blue-600 hover:text-blue-800 text-xs shrink-0 underline underline-offset-2 decoration-blue-300/60 hover:decoration-blue-600 transition-colors"
      title={`打开工作区面板，在文件树中找到:\n${relPath}`}
    >
      {label}
    </button>
  );
}

function RestrictedPathLabel({ absPath, reason }: { absPath: string; reason: string }) {
  return (
    <span className="text-xs text-gray-400 shrink-0 cursor-default" title={`${reason}\n${absPath}`}>
      受保护
    </span>
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
    { name: 'cat-config.json', path: `${projectRoot}/cat-config.json`, desc: '猫猫配置（模型、适配器）', isDir: false },
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

function ConfigFilesSection({ projectRoot }: { projectRoot: string }) {
  const files = useMemo(() => buildConfigFiles(projectRoot), [projectRoot]);
  return (
    <Section title="配置文件">
      <div className="space-y-2">
        {files.map((f) => {
          const cls = classifyPath(f.path, projectRoot, f.isDir);
          return (
            <div key={f.name} className="flex items-baseline gap-2">
              <code className="text-xs font-mono text-gray-700 bg-gray-200 px-1.5 py-0.5 rounded shrink-0">
                {f.name}
              </code>
              <span className="text-xs text-gray-500">{f.desc}</span>
              <PathAction classification={cls} absPath={f.path} />
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function EnvVarsSection({ categories, variables }: { categories: Record<string, string>; variables: EnvVar[] }) {
  const grouped = Object.entries(categories)
    .map(([key, label]) => ({
      key,
      label,
      vars: variables.filter((v) => v.category === key),
    }))
    .filter((g) => g.vars.length > 0);

  return (
    <Section title="环境变量">
      <div className="space-y-3">
        {grouped.map((group) => (
          <div key={group.key}>
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{group.label}</p>
            <div className="space-y-1">
              {group.vars.map((v) => (
                <div key={v.name} className="grid grid-cols-[1fr_auto_auto] gap-x-3 items-baseline text-xs">
                  <div className="flex items-baseline gap-1.5 min-w-0">
                    <code className="font-mono text-gray-700 shrink-0">{v.name}</code>
                    <span className="text-gray-400 truncate">{v.description}</span>
                  </div>
                  <span className="text-gray-400 text-[11px]">默认: {v.defaultValue}</span>
                  <span className={`font-mono text-[11px] ${v.currentValue ? 'text-green-600' : 'text-gray-300'}`}>
                    {v.currentValue ?? '未设置'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function DataDirsSection({ dataDirs, projectRoot }: { dataDirs: DataDirs; projectRoot: string }) {
  const dirs = useMemo(() => buildDataDirs(dataDirs), [dataDirs]);
  return (
    <Section title="数据目录">
      <div className="space-y-2">
        {dirs.map((d) => {
          const cls = classifyPath(d.path, projectRoot, d.isDir);
          return (
            <div key={d.name} className="flex items-baseline gap-2">
              <span className="text-xs text-gray-700 font-medium shrink-0">{d.name}</span>
              <span className="text-xs text-gray-500">{d.desc}</span>
              <PathAction classification={cls} absPath={d.path} />
            </div>
          );
        })}
      </div>
    </Section>
  );
}

export function HubEnvFilesTab() {
  const [data, setData] = useState<EnvSummaryData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch('/api/config/env-summary')
      .then(async (res) => {
        if (res.ok) setData((await res.json()) as EnvSummaryData);
        else setError('环境信息加载失败');
      })
      .catch(() => setError('环境信息加载失败'));
  }, []);

  if (error) return <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{error}</p>;
  if (!data) return <p className="text-sm text-gray-400">加载中...</p>;

  return (
    <>
      <ConfigFilesSection projectRoot={data.paths.projectRoot} />
      <EnvVarsSection categories={data.categories} variables={data.variables} />
      <DataDirsSection dataDirs={data.paths.dataDirs} projectRoot={data.paths.projectRoot} />
    </>
  );
}
