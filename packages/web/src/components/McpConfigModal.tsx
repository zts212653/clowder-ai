'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '@/utils/api-client';
import { McpModalActions, McpPreviewSection, McpToolsSection } from './McpConfigModalPanels';
import {
  type McpEditData,
  McpIdentitySection,
  type McpInstallPreview,
  McpModalHeader,
  McpResolverSection,
  type McpTool,
  type McpTransport,
  McpTransportFields,
} from './McpConfigModalSections';
import { type KVPair, kvToObj } from './mcp-form-helpers';

export interface McpConfigModalProps {
  projectPath?: string;
  editId?: string;
  editData?: McpEditData;
  readOnly?: boolean;
  tools?: McpTool[];
  onSaved: () => void;
  onClose: () => void;
}

interface BuildPayloadInput {
  id: string;
  projectPath?: string;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string;
  headers: KVPair[];
  envPairs: KVPair[];
  resolver?: string;
  isEdit: boolean;
}

function recordToPairs(record: Record<string, string> | undefined, addDefault = true): KVPair[] {
  if (!record || Object.keys(record).length === 0) return addDefault ? [{ key: '', value: '' }] : [];
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

function sanitizedRecord(pairs: KVPair[]): Record<string, string> {
  return kvToObj(pairs, { omitBlankValue: true });
}

function stdioPayload(input: BuildPayloadInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (input.command.trim()) payload.command = input.command.trim();
  const cleanArgs = input.args.map((value) => value.trim()).filter(Boolean);
  if (cleanArgs.length > 0) payload.args = cleanArgs;
  return payload;
}

function httpPayload(input: BuildPayloadInput): Record<string, unknown> {
  const payload: Record<string, unknown> = { transport: 'streamableHttp' };
  if (input.url.trim()) payload.url = input.url.trim();
  const headers = sanitizedRecord(input.headers);
  if (Object.keys(headers).length > 0) payload.headers = headers;
  return payload;
}

function buildMcpPayload(input: BuildPayloadInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: input.id.trim(),
    ...(input.projectPath ? { projectPath: input.projectPath } : {}),
    ...(input.transport === 'streamableHttp' ? httpPayload(input) : stdioPayload(input)),
  };
  const env = sanitizedRecord(input.envPairs);
  if (Object.keys(env).length > 0) payload.env = env;
  if (input.resolver && !input.isEdit) payload.resolver = input.resolver;
  return payload;
}

async function readApiError(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? `${fallback} (${res.status})`;
}

function modalSubtitle(readOnly: boolean, isEdit: boolean): string {
  if (readOnly) return '托管 MCP 为只读预览，敏感值仅显示键名。';
  if (isEdit) return '敏感值已掩码，未改动的字段保留原值。';
  return '先预览将改动的 CLI 配置，再确认安装。';
}

type ProbeConnectionStatus = 'connected' | 'disconnected' | 'timeout' | 'error' | 'unknown';

/** Build the ad-hoc probe request body from current form state. */
function buildProbeBody(
  transport: McpTransport,
  command: string,
  args: string[],
  url: string,
  headers: KVPair[],
  envPairs: KVPair[],
  probeProjectPath?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (transport === 'streamableHttp') {
    if (url.trim()) body.url = url.trim();
    body.transport = 'streamableHttp';
    const h = sanitizedRecord(headers);
    if (Object.keys(h).length > 0) body.headers = h;
  } else {
    if (command.trim()) body.command = command.trim();
    const cleanArgs = args.map((a) => a.trim()).filter(Boolean);
    if (cleanArgs.length > 0) body.args = cleanArgs;
  }
  const env = sanitizedRecord(envPairs);
  if (Object.keys(env).length > 0) body.env = env;
  // #712 P2-1: project-scoped probe resolves saved config + relative paths
  // against the project root instead of STARTUP_REPO_ROOT.
  if (probeProjectPath) body.projectPath = probeProjectPath;
  return body;
}

export function McpConfigModal({
  projectPath,
  editId,
  editData,
  readOnly = false,
  tools: initialTools,
  onSaved,
  onClose,
}: McpConfigModalProps) {
  const isEdit = Boolean(editId);
  const [id, setId] = useState(editId ?? '');
  const [transport, setTransport] = useState<McpTransport>(editData?.transport ?? 'stdio');
  const [command, setCommand] = useState(editData?.command ?? '');
  const [args, setArgs] = useState<string[]>(editData?.args?.length ? editData.args : ['']);
  const [envPairs, setEnvPairs] = useState<KVPair[]>(recordToPairs(editData?.env, !isEdit));
  const [url, setUrl] = useState(editData?.url ?? '');
  const [headers, setHeaders] = useState<KVPair[]>(recordToPairs(editData?.headers, !isEdit));
  const [preview, setPreview] = useState<McpInstallPreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tool probing state — modal owns probing so user can re-probe with edited config.
  const [probeTools, setProbeTools] = useState<McpTool[] | undefined>(initialTools);
  const [probeLoading, setProbeLoading] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probeStatus, setProbeStatus] = useState<ProbeConnectionStatus>('unknown');

  const resetPreview = useCallback(() => setPreview(null), []);

  useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const buildPayload = useCallback(() => {
    return buildMcpPayload({
      id,
      projectPath,
      transport,
      command,
      args,
      url,
      headers,
      envPairs,
      resolver: editData?.resolver,
      isEdit,
    });
  }, [args, command, editData?.resolver, envPairs, headers, id, isEdit, projectPath, transport, url]);

  // Probe tools using the current form values (ad-hoc, no save required).
  const handleProbeTools = useCallback(async () => {
    if (!id.trim()) return;
    setProbeLoading(true);
    setProbeError(null);
    try {
      const probeBody = buildProbeBody(transport, command, args, url, headers, envPairs, projectPath);
      const res = await apiFetch(`/api/mcp/${encodeURIComponent(id)}/tools`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(probeBody),
      });
      const data = (await res.json()) as {
        tools?: McpTool[];
        connectionStatus?: ProbeConnectionStatus;
        error?: string;
      };
      setProbeTools(data.tools ?? []);
      setProbeStatus(data.connectionStatus ?? 'unknown');
      if (data.error) setProbeError(data.error);
    } catch {
      setProbeError('探测请求失败');
      setProbeStatus('error');
    } finally {
      setProbeLoading(false);
    }
  }, [args, command, envPairs, headers, id, projectPath, transport, url]);

  // Auto-probe on mount for edit mode (existing MCP).
  const mountProbed = useRef(false);
  useEffect(() => {
    if (mountProbed.current) return;
    if (isEdit && editId && !initialTools) {
      mountProbed.current = true;
      void handleProbeTools();
    }
  }, [editId, handleProbeTools, initialTools, isEdit]);

  // Sync externally provided tools (from parent's initial load).
  useEffect(() => {
    if (initialTools) {
      setProbeTools(initialTools);
      setProbeStatus('connected');
    }
  }, [initialTools]);

  const handlePreview = useCallback(async () => {
    if (!id.trim()) return;
    setError(null);
    setPreview(null);
    setPreviewing(true);
    try {
      const res = await apiFetch('/api/capabilities/mcp/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });
      if (!res.ok) {
        setError(await readApiError(res as Response, '预览失败'));
        return;
      }
      setPreview((await res.json()) as McpInstallPreview);
    } catch {
      setError('网络错误');
    } finally {
      setPreviewing(false);
    }
  }, [buildPayload, id]);

  const handleInstall = useCallback(async () => {
    if (!id.trim()) return;
    setError(null);
    setInstalling(true);
    try {
      const res = await apiFetch('/api/capabilities/mcp/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });
      if (!res.ok) {
        setError(await readApiError(res as Response, isEdit ? '保存失败' : '安装失败'));
        return;
      }
      onSaved();
      onClose();
    } catch {
      setError('网络错误');
    } finally {
      setInstalling(false);
    }
  }, [buildPayload, id, isEdit, onClose, onSaved]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await handleInstall();
    } finally {
      setSaving(false);
    }
  }, [handleInstall]);

  // F249 §8.3: "恢复全局配置" — clear project override, restore to global config
  const [restoring, setRestoring] = useState(false);
  const canRestoreGlobal = isEdit && !!projectPath;
  const handleRestoreGlobal = useCallback(async () => {
    if (!editId || !projectPath) return;
    setError(null);
    setRestoring(true);
    try {
      const res = await apiFetch('/api/capabilities/mcp/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editId, projectPath, clearOverride: true }),
      });
      if (!res.ok) {
        setError(await readApiError(res as Response, '恢复失败'));
        return;
      }
      onSaved();
      onClose();
    } catch {
      setError('网络错误');
    } finally {
      setRestoring(false);
    }
  }, [editId, onClose, onSaved, projectPath]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] px-4 backdrop-blur-sm"
      data-testid="mcp-config-modal"
    >
      <button type="button" aria-label="关闭" className="absolute inset-0 cursor-default" onClick={onClose} />
      <div className="relative flex max-h-[85vh] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl bg-[var(--console-card-bg)] px-6 py-4 shadow-[0_24px_56px_rgba(43,33,26,0.14)]">
        <McpModalHeader
          title={readOnly ? id : isEdit ? `编辑 ${id}` : '新增 MCP'}
          subtitle={modalSubtitle(readOnly, isEdit)}
          onClose={onClose}
        />
        <div className="mt-3 flex-1 space-y-2.5 overflow-y-auto">
          {error && (
            <div className="console-status-chip" data-status="error">
              {error}
            </div>
          )}
          <McpIdentitySection
            id={id}
            isEdit={isEdit}
            readOnly={readOnly}
            transport={transport}
            onIdChange={(value) => {
              setId(value);
              resetPreview();
            }}
            onTransportChange={(value) => {
              setTransport(value);
              resetPreview();
            }}
          />
          <McpResolverSection resolver={editData?.resolver} />
          <McpTransportFields
            transport={transport}
            readOnly={readOnly}
            isEdit={isEdit}
            command={command}
            args={args}
            envPairs={envPairs}
            url={url}
            headers={headers}
            editData={editData}
            onCommandChange={(value) => {
              setCommand(value);
              resetPreview();
            }}
            onArgsChange={(values) => {
              setArgs(values);
              resetPreview();
            }}
            onEnvPairsChange={(pairs) => {
              setEnvPairs(pairs);
              resetPreview();
            }}
            onUrlChange={(value) => {
              setUrl(value);
              resetPreview();
            }}
            onHeadersChange={(pairs) => {
              setHeaders(pairs);
              resetPreview();
            }}
          />
          <McpToolsSection
            tools={probeTools}
            loading={probeLoading}
            connectionStatus={probeStatus}
            error={probeError}
            onProbe={readOnly ? undefined : handleProbeTools}
          />
          <McpPreviewSection preview={preview} />
        </div>
        {!readOnly && (
          <div className="mt-3 flex items-center justify-between">
            <div>
              {canRestoreGlobal && (
                <button
                  type="button"
                  disabled={restoring}
                  onClick={handleRestoreGlobal}
                  className="rounded-lg border border-[var(--console-border-soft)] px-3 py-1.5 text-xs text-cafe-muted transition-colors hover:text-cafe-accent disabled:opacity-50"
                >
                  {restoring ? '恢复中…' : '恢复全局配置'}
                </button>
              )}
            </div>
            <McpModalActions
              isEdit={isEdit}
              id={id}
              preview={preview}
              saving={saving}
              previewing={previewing}
              installing={installing}
              onCancel={onClose}
              onPreview={handlePreview}
              onSaveOrInstall={isEdit ? handleSave : handleInstall}
            />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
