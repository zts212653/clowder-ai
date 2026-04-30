'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import {
  DynamicKVList,
  DynamicList,
  FormItem,
  FormSection,
  formInputClass,
  type KVPair,
  kvToObj,
} from './mcp-form-helpers';

type Transport = 'stdio' | 'streamableHttp';

export interface McpConfigModalProps {
  projectPath?: string;
  editId?: string;
  editData?: {
    transport?: Transport;
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    resolver?: string;
    resolvedCommand?: string;
    resolvedArgs?: string[];
    envKeys?: string[];
  };
  onSaved: () => void;
  onClose: () => void;
}

export function McpConfigModal({ projectPath, editId, editData, onSaved, onClose }: McpConfigModalProps) {
  const isEdit = Boolean(editId);
  const isResolver = Boolean(editData?.resolver);
  const isHttpEdit = isEdit && editData?.transport === 'streamableHttp';
  const [id, setId] = useState(editId ?? '');
  const [transport, setTransport] = useState<Transport>(editData?.transport ?? 'stdio');

  const [command, setCommand] = useState(editData?.command ?? '');
  const [args, setArgs] = useState<string[]>(editData?.args?.length ? editData.args : ['']);
  const [envPairs, setEnvPairs] = useState<KVPair[]>(
    editData?.env ? Object.entries(editData.env).map(([key, value]) => ({ key, value })) : [{ key: '', value: '' }],
  );
  const [url, setUrl] = useState(editData?.url ?? '');
  const [headers, setHeaders] = useState<KVPair[]>(
    editData?.headers
      ? Object.entries(editData.headers).map(([key, value]) => ({ key, value }))
      : [{ key: '', value: '' }],
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const buildPayload = useCallback(() => {
    const payload: Record<string, unknown> = { id: id.trim() };
    if (projectPath) payload.projectPath = projectPath;

    if (transport === 'streamableHttp') {
      payload.transport = 'streamableHttp';
      if (url.trim()) payload.url = url.trim();
      const h = kvToObj(headers);
      if (Object.keys(h).length > 0) payload.headers = h;
    } else {
      if (command.trim()) payload.command = command.trim();
      const cleanArgs = args.filter((a) => a.trim());
      if (cleanArgs.length > 0) payload.args = cleanArgs;
    }

    const env = kvToObj(envPairs);
    if (Object.keys(env).length > 0) payload.env = env;

    return payload;
  }, [id, transport, command, args, url, headers, envPairs, projectPath]);

  const handleSave = useCallback(async () => {
    if (!id.trim()) return;
    setError(null);
    setSaving(true);
    try {
      const payload = buildPayload();

      const res = await apiFetch('/api/capabilities/mcp/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as Record<string, string>;
        setError(data.error ?? `保存失败 (${res.status})`);
        return;
      }

      if (isEdit && payload.env) {
        const envRes = await apiFetch(`/api/capabilities/mcp/${encodeURIComponent(id.trim())}/env`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ env: payload.env, projectPath }),
        });
        if (!envRes.ok) {
          const data = (await envRes.json().catch(() => ({}))) as Record<string, string>;
          setError(data.error ?? `环境变量更新失败 (${envRes.status})`);
          return;
        }
      }

      onSaved();
      onClose();
    } catch {
      setError('网络错误');
    } finally {
      setSaving(false);
    }
  }, [id, isEdit, buildPayload, onSaved, onClose, projectPath]);

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
      data-testid="mcp-config-modal"
    >
      <div className="flex max-h-[85vh] w-[776px] flex-col overflow-hidden rounded-[28px] bg-[var(--console-card-bg)] shadow-[0_24px_56px_rgba(43,33,26,0.14)]">
        <div className="px-[30px] pt-6 pb-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-2">
              <h2 className="text-[28px] font-extrabold text-cafe">{isEdit ? `更新 ${id}` : '连接至自定义 MCP'}</h2>
              {!isEdit && (
                <p className="text-sm text-cafe-secondary">
                  新增 STDIO MCP 使用同一浅色表单骨架；类型切换只改变字段集合。
                </p>
              )}
              {isHttpEdit && (
                <p className="text-sm text-cafe-secondary">
                  HTTP Stream 服务类型已固定；如需切换 MCP 服务器类型，请先卸载当前配置。
                </p>
              )}
            </div>
            {isHttpEdit && (
              <button
                type="button"
                disabled
                title="卸载功能即将上线"
                className="flex shrink-0 items-center gap-2 rounded-[14px] bg-conn-red-bg px-[18px] text-[15px] font-extrabold text-conn-red-text opacity-50 cursor-not-allowed"
                style={{ height: 44 }}
              >
                <svg
                  className="h-[18px] w-[18px]"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
                卸载
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto space-y-2.5 px-[30px] pb-5">
          {error && (
            <div className="console-status-chip" data-status="error">
              {error}
            </div>
          )}

          {!isHttpEdit && (
            <FormSection>
              <FormItem label="名称">
                <input
                  type="text"
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  placeholder="MCP server name"
                  className={`${formInputClass} disabled:opacity-60`}
                  disabled={isEdit}
                />
              </FormItem>
              {!isResolver && !isEdit && (
                <FormItem label="传输方式">
                  <div className="flex h-[46px] gap-1 rounded-[14px] bg-[var(--console-card-soft-bg)] p-1">
                    <button
                      type="button"
                      className={`flex-1 rounded-[10px] text-[13px] font-extrabold transition-colors ${transport === 'stdio' ? 'bg-[var(--cafe-accent)] text-[var(--cafe-accent-foreground)]' : 'text-cafe-secondary'}`}
                      onClick={() => setTransport('stdio')}
                    >
                      STDIO
                    </button>
                    <button
                      type="button"
                      className={`flex-1 rounded-[10px] text-[13px] font-extrabold transition-colors ${transport === 'streamableHttp' ? 'bg-[var(--cafe-accent)] text-[var(--cafe-accent-foreground)]' : 'text-cafe-secondary'}`}
                      onClick={() => setTransport('streamableHttp')}
                    >
                      流式 HTTP
                    </button>
                  </div>
                </FormItem>
              )}
            </FormSection>
          )}

          {isResolver && editData?.resolvedCommand && (
            <FormSection>
              <FormItem label="Resolver">
                <div className="console-pill px-3 py-1.5 text-xs text-cafe-secondary">{editData.resolver}</div>
              </FormItem>
              <FormItem label="解析后的启动命令（只读）">
                <div className="rounded-lg bg-[var(--console-code-bg)] px-3 py-2 font-mono text-xs text-cafe-secondary">
                  {editData.resolvedCommand} {editData.resolvedArgs?.join(' ')}
                </div>
              </FormItem>
              {editData.envKeys && editData.envKeys.length > 0 && (
                <FormItem label="已配置环境变量">
                  <div className="flex flex-wrap gap-1.5">
                    {editData.envKeys.map((k) => (
                      <span key={k} className="console-pill px-2 py-0.5 text-xs">
                        {k}
                      </span>
                    ))}
                  </div>
                </FormItem>
              )}
              <FormItem label="环境变量（可编辑）">
                <DynamicKVList pairs={envPairs} onChange={setEnvPairs} addLabel="环境变量" />
              </FormItem>
            </FormSection>
          )}

          {!isResolver && transport === 'stdio' && (
            <FormSection>
              <FormItem label="启动命令">
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="e.g. npx"
                  className={formInputClass}
                />
              </FormItem>
              <FormItem label="参数">
                <DynamicList values={args} placeholder="" onChange={setArgs} addLabel="参数" />
              </FormItem>
              <FormItem label="环境变量">
                <DynamicKVList pairs={envPairs} onChange={setEnvPairs} addLabel="环境变量" />
              </FormItem>
            </FormSection>
          )}

          {!isResolver && transport === 'streamableHttp' && (
            <>
              <HttpEndpointCard url={url} onUrlChange={setUrl} envPairs={envPairs} onEnvChange={setEnvPairs} />
              <HttpHeadersCard headers={headers} onChange={setHeaders} />
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-[30px] py-4">
          <button type="button" onClick={onClose} className="console-button-ghost">
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!id.trim() || saving}
            className="h-[42px] rounded-[14px] bg-[var(--cafe-accent)] px-[18px] text-[15px] font-extrabold text-[var(--cafe-accent-foreground)] disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

function HttpEndpointCard({
  url,
  onUrlChange,
  envPairs,
  onEnvChange,
}: {
  url: string;
  onUrlChange: (v: string) => void;
  envPairs: KVPair[];
  onEnvChange: (p: KVPair[]) => void;
}) {
  return (
    <div className="rounded-[18px] bg-[var(--console-card-soft-bg)] p-4 space-y-3">
      <div className="space-y-2">
        <p className="text-[15px] font-extrabold text-cafe">URL</p>
        <input
          type="text"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="https://mcp.example.com/mcp"
          className="h-[46px] w-full rounded-xl bg-[var(--console-active-bg)] px-3.5 text-sm text-cafe outline-none"
        />
      </div>
      <div className="space-y-2">
        <p className="text-[15px] font-extrabold text-cafe">环境变量</p>
        <DynamicKVList pairs={envPairs} onChange={onEnvChange} addLabel="环境变量" />
      </div>
    </div>
  );
}

function HttpHeadersCard({ headers, onChange }: { headers: KVPair[]; onChange: (p: KVPair[]) => void }) {
  return (
    <div className="rounded-[18px] bg-[var(--console-card-soft-bg)] p-4 space-y-2.5">
      <p className="text-[15px] font-extrabold text-cafe">标头</p>
      <DynamicKVList pairs={headers} onChange={onChange} addLabel="标头" />
    </div>
  );
}
