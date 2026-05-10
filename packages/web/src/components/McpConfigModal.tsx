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
  readOnly?: boolean;
  tools?: { name: string; description?: string }[];
  onSaved: () => void;
  onClose: () => void;
}

export function McpConfigModal({
  projectPath,
  editId,
  editData,
  readOnly,
  tools,
  onSaved,
  onClose,
}: McpConfigModalProps) {
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

      onSaved();
      onClose();
    } catch {
      setError('网络错误');
    } finally {
      setSaving(false);
    }
  }, [id, buildPayload, onSaved, onClose]);

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--console-overlay-backdrop)]"
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
      data-testid="mcp-config-modal"
    >
      <div className="flex max-h-[85vh] w-full max-w-[580px] flex-col overflow-hidden rounded-2xl bg-[var(--console-card-bg)] px-6 py-4 shadow-[0_24px_56px_rgba(43,33,26,0.14)]">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <h2 className="text-lg font-bold text-cafe">
              {readOnly ? id : isEdit ? `更新 ${id}` : '连接至自定义 MCP'}
            </h2>
            {!readOnly && !isEdit && (
              <p className="text-xs text-cafe-secondary">
                新增 STDIO MCP 使用同一浅色表单骨架；类型切换只改变字段集合。
              </p>
            )}
            {!readOnly && isHttpEdit && (
              <p className="text-xs text-cafe-secondary">
                HTTP Stream 服务类型已固定；如需切换 MCP 服务器类型，请先卸载当前配置。
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-[16px] text-cafe-muted transition hover:bg-[var(--console-modal-close-bg)] hover:text-[var(--console-modal-close-fg)]"
          >
            ✕
          </button>
        </div>

        <div className="mt-3 flex-1 space-y-2.5 overflow-y-auto">
          {error && (
            <div className="console-status-chip" data-status="error">
              {error}
            </div>
          )}

          <FormSection>
            <FormItem label="名称">
              <input
                type="text"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="MCP server name"
                className={`${formInputClass} disabled:opacity-60`}
                disabled={isEdit || readOnly}
              />
            </FormItem>
            {!isResolver && !isEdit && !readOnly && (
              <FormItem label="传输方式">
                <div className="flex h-10 gap-1 rounded-xl bg-[var(--console-field-bg)] p-1">
                  <button
                    type="button"
                    className={`flex h-8 flex-1 items-center justify-center rounded-lg text-xs font-bold transition-colors ${transport === 'stdio' ? 'bg-[var(--cafe-accent)] text-[var(--cafe-surface)]' : 'text-cafe-secondary'}`}
                    onClick={() => setTransport('stdio')}
                  >
                    STDIO
                  </button>
                  <button
                    type="button"
                    className={`flex h-8 flex-1 items-center justify-center rounded-lg text-xs font-bold transition-colors ${transport === 'streamableHttp' ? 'bg-[var(--cafe-accent)] text-[var(--cafe-surface)]' : 'text-cafe-secondary'}`}
                    onClick={() => setTransport('streamableHttp')}
                  >
                    流式 HTTP
                  </button>
                </div>
              </FormItem>
            )}
            {(isEdit || readOnly) && (
              <FormItem label="传输方式">
                <div className="flex h-10 items-center rounded-xl bg-[var(--console-field-bg)] px-3 text-compact font-bold text-cafe-secondary">
                  {transport === 'streamableHttp' ? '流式 HTTP' : 'STDIO'}
                </div>
              </FormItem>
            )}
          </FormSection>

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
              {!readOnly && (
                <FormItem label="环境变量（可编辑）">
                  <DynamicKVList pairs={envPairs} onChange={setEnvPairs} addLabel="环境变量" />
                </FormItem>
              )}
            </FormSection>
          )}

          {!isResolver && transport === 'stdio' && (
            <FormSection>
              <FormItem label="启动命令">
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder={isEdit && !readOnly ? '留空保留现有命令' : 'e.g. npx'}
                  className={`${formInputClass} disabled:opacity-60`}
                  disabled={readOnly}
                />
              </FormItem>
              <FormItem label="参数">
                {readOnly ? (
                  <div className="rounded-lg bg-[var(--console-code-bg)] px-3 py-2 font-mono text-xs text-cafe-secondary">
                    {args.filter((a) => a.trim()).join(' ') || '—'}
                  </div>
                ) : (
                  <>
                    <DynamicList
                      values={args}
                      placeholder={isEdit ? '留空保留现有参数' : ''}
                      onChange={setArgs}
                      addLabel="参数"
                    />
                    {isEdit && args.every((a) => !a.trim()) && (
                      <p className="mt-1 text-label text-cafe-muted">提交时留空将保留服务器的现有参数不变</p>
                    )}
                  </>
                )}
              </FormItem>
              {!readOnly && (
                <FormItem label="环境变量">
                  <DynamicKVList pairs={envPairs} onChange={setEnvPairs} addLabel="环境变量" />
                </FormItem>
              )}
              {readOnly && editData?.envKeys && editData.envKeys.length > 0 && (
                <FormItem label="环境变量">
                  <div className="flex flex-wrap gap-1.5">
                    {editData.envKeys.map((k) => (
                      <span key={k} className="console-pill px-2 py-0.5 text-xs">
                        {k}
                      </span>
                    ))}
                  </div>
                </FormItem>
              )}
            </FormSection>
          )}

          {!isResolver && transport === 'streamableHttp' && (
            <>
              {readOnly ? (
                <FormSection>
                  <FormItem label="URL">
                    <div className="rounded-lg bg-[var(--console-code-bg)] px-3 py-2 font-mono text-xs text-cafe-secondary">
                      {editData?.url || '—'}
                    </div>
                  </FormItem>
                  {editData?.envKeys && editData.envKeys.length > 0 && (
                    <FormItem label="环境变量">
                      <div className="flex flex-wrap gap-1.5">
                        {editData.envKeys.map((k) => (
                          <span key={k} className="console-pill px-2 py-0.5 text-xs">
                            {k}
                          </span>
                        ))}
                      </div>
                    </FormItem>
                  )}
                </FormSection>
              ) : (
                <>
                  <HttpEndpointCard
                    url={url}
                    onUrlChange={setUrl}
                    envPairs={envPairs}
                    onEnvChange={setEnvPairs}
                    placeholder={isEdit ? '留空保留现有 URL' : undefined}
                  />
                  <HttpHeadersCard headers={headers} onChange={setHeaders} />
                </>
              )}
            </>
          )}

          <FormSection>
            <FormItem label={tools && tools.length > 0 ? `工具 (${tools.length})` : '工具'}>
              {tools && tools.length > 0 ? (
                <div className="max-h-[30vh] space-y-1 overflow-y-auto">
                  {tools.map((t) => (
                    <div key={t.name} className="rounded-[10px] bg-[var(--console-panel-bg)] px-3 py-2">
                      <p className="text-compact font-bold text-cafe">{t.name}</p>
                      {t.description && <p className="mt-0.5 text-label text-cafe-muted">{t.description}</p>}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-[10px] bg-[var(--console-panel-bg)] px-3 py-2.5 text-[12px] text-cafe-muted">
                  未探测到工具（服务未连接或无已注册工具）
                </div>
              )}
            </FormItem>
          </FormSection>
        </div>

        {!readOnly && (
          <div className="mt-3 flex items-center justify-end">
            <button
              type="button"
              onClick={handleSave}
              disabled={!id.trim() || saving}
              className="h-9 rounded-xl bg-[var(--cafe-accent)] px-4 text-sm font-bold text-[var(--cafe-surface)] transition hover:bg-[var(--cafe-accent-hover)] disabled:opacity-50"
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function HttpEndpointCard({
  url,
  onUrlChange,
  envPairs,
  onEnvChange,
  placeholder,
}: {
  url: string;
  onUrlChange: (v: string) => void;
  envPairs: KVPair[];
  onEnvChange: (p: KVPair[]) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-3 rounded-[18px] p-4">
      <div className="space-y-2">
        <p className="text-sm font-bold text-cafe">URL</p>
        <input
          type="text"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder={placeholder ?? 'https://mcp.example.com/mcp'}
          className={formInputClass}
        />
      </div>
      <div className="space-y-2">
        <p className="text-sm font-bold text-cafe">环境变量</p>
        <DynamicKVList pairs={envPairs} onChange={onEnvChange} addLabel="环境变量" />
      </div>
    </div>
  );
}

function HttpHeadersCard({ headers, onChange }: { headers: KVPair[]; onChange: (p: KVPair[]) => void }) {
  return (
    <div className="space-y-2.5 rounded-[18px] p-4">
      <p className="text-sm font-bold text-cafe">标头</p>
      <DynamicKVList pairs={headers} onChange={onChange} addLabel="标头" />
    </div>
  );
}
