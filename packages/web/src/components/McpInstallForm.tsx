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
}

type Transport = 'stdio' | 'streamableHttp';

export function McpInstallForm({ projectPath, onInstalled, onClose }: McpInstallFormProps) {
  const [id, setId] = useState('');
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
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-green-600 font-medium">MCP &ldquo;{id}&rdquo; 已安装</span>
          {result.probe && (
            <span
              className={`text-xs px-1.5 py-0.5 rounded ${
                result.probe.connectionStatus === 'connected'
                  ? 'bg-green-50 text-green-600'
                  : 'bg-amber-50 text-amber-600'
              }`}
            >
              {result.probe.connectionStatus}
            </span>
          )}
        </div>
        <button type="button" onClick={onClose} className="text-xs text-cafe-accent hover:underline">
          关闭
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-cafe-secondary">添加 MCP</h3>

      {error && <p className="text-xs text-red-500 bg-red-50 rounded px-2 py-1">{error}</p>}

      {/* ID */}
      <Field label="ID" required>
        <input
          type="text"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="e.g. agent-browser"
          className="form-input"
        />
      </Field>

      {/* Transport */}
      <Field label="传输协议">
        <select value={transport} onChange={(e) => setTransport(e.target.value as Transport)} className="form-input">
          <option value="stdio">stdio (本地命令)</option>
          <option value="streamableHttp">streamableHttp (远程 URL)</option>
        </select>
      </Field>

      {/* Stdio fields */}
      {transport === 'stdio' && (
        <>
          <Field label="命令">
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="e.g. npx"
              className="form-input"
            />
          </Field>
          <Field label="参数 (空格分隔)">
            <input
              type="text"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="e.g. agent-browser-mcp"
              className="form-input"
            />
          </Field>
        </>
      )}

      {/* StreamableHttp fields */}
      {transport === 'streamableHttp' && (
        <Field label="URL">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://mcp.example.com/api"
            className="form-input"
          />
        </Field>
      )}

      {/* Advanced: resolver */}
      <Field label="Resolver (高级)">
        <input
          type="text"
          value={resolver}
          onChange={(e) => setResolver(e.target.value)}
          placeholder="e.g. chrome-extension"
          className="form-input"
        />
      </Field>

      {/* Env */}
      <Field label="环境变量 (KEY=VALUE 每行一个)">
        <textarea
          value={envPairs}
          onChange={(e) => setEnvPairs(e.target.value)}
          rows={2}
          placeholder="API_KEY=xxx"
          className="form-input resize-y"
        />
      </Field>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={handlePreview}
          disabled={!id.trim()}
          className="px-3 py-1.5 text-xs rounded bg-cafe-surface border border-cafe text-cafe-secondary
                     hover:bg-cafe-surface-hover disabled:opacity-40"
        >
          预览
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-xs text-cafe-muted hover:text-cafe-secondary"
        >
          取消
        </button>
      </div>

      {/* Preview result */}
      {preview && (
        <div className="rounded-lg border border-cafe bg-cafe-surface/50 p-3 space-y-2">
          <p className="text-xs font-medium text-cafe-secondary">安装预览</p>
          <div className="text-xs text-cafe-muted space-y-1">
            <p>
              ID: <span className="text-cafe-secondary">{preview.entry.id}</span>
            </p>
            <p>将更新: {preview.cliConfigsAffected.join(', ')}</p>
            {preview.willProbe && <p className="text-blue-500">安装后将自动探测连接状态</p>}
          </div>
          {preview.risks.length > 0 && (
            <div className="space-y-0.5">
              {preview.risks.map((r) => (
                <p key={r} className="text-xs text-amber-600">
                  ⚠ {r}
                </p>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={handleInstall}
            disabled={installing}
            className="mt-1 px-3 py-1.5 text-xs rounded bg-cafe-accent text-white
                       hover:bg-cafe-accent/90 disabled:opacity-50"
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
      <span className="text-cafe-muted mb-0.5 block">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </span>
      {children}
    </label>
  );
}
