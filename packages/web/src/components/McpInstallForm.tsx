'use client';

import { useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface McpInstallPreview {
  entry: { id: string; type: string; enabled: boolean; source: string; mcpServer?: Record<string, unknown> };
  cliConfigsAffected: string[];
  willProbe: boolean;
  risks: string[];
}

interface McpInstallFormProps {
  projectPath?: string;
  onInstalled: () => void;
  onClose: () => void;
  prefilledId?: string;
}

type Transport = 'stdio' | 'streamableHttp';

export function McpInstallForm({ projectPath, onInstalled, onClose, prefilledId }: McpInstallFormProps) {
  const [id, setId] = useState(prefilledId ?? '');
  const [transport, setTransport] = useState<Transport>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [envPairs, setEnvPairs] = useState('');
  const [resolver, setResolver] = useState('');
  const [preview, setPreview] = useState<McpInstallPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; probe?: { connectionStatus: string } } | null>(null);

  const buildPayload = useCallback(() => {
    const payload: Record<string, unknown> = { id: id.trim() };
    if (projectPath) payload.projectPath = projectPath;
    if (transport === 'streamableHttp') {
      payload.transport = 'streamableHttp';
      if (url.trim()) payload.url = url.trim();
    } else {
      if (command.trim()) payload.command = command.trim();
      if (args.trim()) payload.args = args.trim().split(/\s+/);
    }
    if (resolver.trim()) payload.resolver = resolver.trim();
    if (envPairs.trim()) {
      const env: Record<string, string> = {};
      for (const line of envPairs.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
      if (Object.keys(env).length > 0) payload.env = env;
    }
    return payload;
  }, [id, transport, command, args, url, envPairs, resolver, projectPath]);

  const handlePreview = useCallback(async () => {
    setError(null);
    setPreview(null);
    try {
      const res = await apiFetch('/api/capabilities/mcp/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as Record<string, string>;
        setError(data.error ?? `预览失败 (${res.status})`);
        return;
      }
      setPreview((await res.json()) as McpInstallPreview);
    } catch {
      setError('网络错误');
    }
  }, [buildPayload]);

  const handleInstall = useCallback(async () => {
    setError(null);
    setInstalling(true);
    try {
      const res = await apiFetch('/api/capabilities/mcp/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as Record<string, string>;
        setError(data.error ?? `安装失败 (${res.status})`);
        return;
      }
      const data = (await res.json()) as { ok: boolean; probe?: { connectionStatus: string } };
      setResult(data);
      onInstalled();
    } catch {
      setError('网络错误');
    } finally {
      setInstalling(false);
    }
  }, [buildPayload, onInstalled]);

  if (result) {
    return (
      <div className="space-y-4">
        <div className="console-card-soft rounded-xl px-4 py-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-conn-green-text">MCP &ldquo;{id}&rdquo; 已安装</span>
            <span
              className="console-status-chip"
              data-status={result.probe?.connectionStatus === 'connected' ? 'active' : 'warning'}
            >
              {result.probe?.connectionStatus ?? 'pending'}
            </span>
          </div>
          {result.probe && (
            <p className="mt-2 text-xs leading-6 text-cafe-secondary">
              安装后已返回探测状态，可直接回到能力列表继续管理。
            </p>
          )}
        </div>
        <button type="button" onClick={onClose} className="console-button-secondary">
          关闭
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cafe-muted">MCP Install</p>
        <h3 className="text-lg font-semibold tracking-[-0.03em] text-cafe">添加 MCP</h3>
        <p className="text-sm leading-6 text-cafe-secondary">
          通过本地命令或远程 URL 注册新的 MCP 服务，先预览影响范围，再确认安装。
        </p>
      </div>

      {error && (
        <div className="console-status-chip" data-status="error">
          {error}
        </div>
      )}

      <div className="console-section-shell rounded-xl p-4">
        <div className="space-y-3">
          <Field label="ID" required>
            <input
              type="text"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="e.g. agent-browser"
              className="console-form-input"
            />
          </Field>

          <Field label="传输协议">
            <div className="console-segmented">
              <button
                type="button"
                data-active={transport === 'stdio' ? 'true' : 'false'}
                className="console-segmented-button"
                onClick={() => setTransport('stdio')}
              >
                stdio
              </button>
              <button
                type="button"
                data-active={transport === 'streamableHttp' ? 'true' : 'false'}
                className="console-segmented-button"
                onClick={() => setTransport('streamableHttp')}
              >
                streamableHttp
              </button>
            </div>
          </Field>
        </div>
      </div>

      {transport === 'stdio' && (
        <div className="console-section-shell rounded-xl p-4">
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cafe-muted">Local Command</p>
            <p className="text-sm text-cafe-secondary">为本地启动的 MCP Server 指定命令和参数。</p>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <Field label="命令">
              <input
                type="text"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="e.g. npx"
                className="console-form-input"
              />
            </Field>
            <Field label="参数 (空格分隔)">
              <input
                type="text"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="e.g. agent-browser-mcp"
                className="console-form-input"
              />
            </Field>
          </div>
        </div>
      )}

      {transport === 'streamableHttp' && (
        <div className="console-section-shell rounded-xl p-4">
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cafe-muted">Remote Endpoint</p>
            <p className="text-sm text-cafe-secondary">把远程 MCP Server 挂进当前项目，适合已有托管服务的场景。</p>
          </div>
          <div className="mt-4">
            <Field label="URL">
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://mcp.example.com/api"
                className="console-form-input"
              />
            </Field>
          </div>
        </div>
      )}

      <div className="console-section-shell rounded-xl p-4">
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cafe-muted">Advanced</p>
          <p className="text-sm text-cafe-secondary">高级配置只在需要定制 resolver 或临时注入环境变量时填写。</p>
        </div>
        <div className="mt-4 grid gap-3">
          <Field label="Resolver (高级)">
            <input
              type="text"
              value={resolver}
              onChange={(e) => setResolver(e.target.value)}
              placeholder="e.g. chrome-extension"
              className="console-form-input"
            />
          </Field>
          <Field label="环境变量 (KEY=VALUE 每行一个)">
            <textarea
              value={envPairs}
              onChange={(e) => setEnvPairs(e.target.value)}
              rows={4}
              placeholder="API_KEY=xxx"
              className="console-form-input resize-y"
            />
          </Field>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          onClick={handlePreview}
          disabled={!id.trim()}
          className="console-button-secondary disabled:opacity-40"
        >
          预览
        </button>
        <button type="button" onClick={onClose} className="console-button-ghost">
          取消
        </button>
      </div>

      {preview && (
        <div className="console-card-soft rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cafe-muted">Install Preview</p>
              <h4 className="mt-1 text-sm font-semibold text-cafe">{preview.entry.id}</h4>
            </div>
            <span className="console-status-chip" data-status={preview.willProbe ? 'active' : 'info'}>
              {preview.willProbe ? '会自动探测' : '仅写入配置'}
            </span>
          </div>
          <div className="console-data-grid">
            <DetailTile label="配置更新" value={preview.cliConfigsAffected.join(', ') || '无'} />
            <DetailTile label="来源" value={preview.entry.source} />
            <DetailTile label="Transport" value={String(preview.entry.type)} />
          </div>
          {preview.risks.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cafe-muted">Risks</p>
              {preview.risks.map((r) => (
                <p key={r} className="console-status-chip mr-2 inline-flex" data-status="warning">
                  {r}
                </p>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={handleInstall}
            disabled={installing}
            className="console-button-primary disabled:opacity-50"
          >
            {installing ? '安装中...' : '确认安装'}
          </button>
        </div>
      )}
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="console-form-label mb-1.5 block">
        {label}
        {required && <span className="ml-0.5 text-conn-red-text">*</span>}
      </span>
      {children}
    </label>
  );
}

function DetailTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="console-data-tile">
      <p className="console-data-tile-label">{label}</p>
      <p className="console-data-tile-value">{value}</p>
    </div>
  );
}
