'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { McpModalActions, McpPreviewSection, McpToolsSection } from './McpConfigModalPanels';
import {
  MaskedSecretNote,
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

const REDACTED_CAPABILITY_SECRET = '••••••';

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

function recordToPairs(record: Record<string, string> | undefined): KVPair[] {
  if (!record || Object.keys(record).length === 0) return [{ key: '', value: '' }];
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

function sanitizedRecord(pairs: KVPair[]): Record<string, string> {
  return kvToObj(pairs, {
    omitBlankValue: true,
    omitValues: [REDACTED_CAPABILITY_SECRET],
  });
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

function ownerHint(error: string): string {
  if (!error.includes('DEFAULT_OWNER_USER_ID')) return error;
  return `DEFAULT_OWNER_USER_ID 未配置：capability 写操作已按 D-3a fail-closed 拒绝。请在 dev 环境配置 DEFAULT_OWNER_USER_ID=default-user 后重试。`;
}

function modalSubtitle(readOnly: boolean, isEdit: boolean): string {
  if (readOnly) return '托管 MCP 为只读预览，敏感值仅显示键名。';
  if (isEdit) return '留空或保留遮罩值会沿用现有配置，不会把遮罩写回后端。';
  return '先预览将改动的 CLI 配置，再确认安装。';
}

export function McpConfigModal({
  projectPath,
  editId,
  editData,
  readOnly = false,
  tools,
  onSaved,
  onClose,
}: McpConfigModalProps) {
  const isEdit = Boolean(editId);
  const [id, setId] = useState(editId ?? '');
  const [transport, setTransport] = useState<McpTransport>(editData?.transport ?? 'stdio');
  const [command, setCommand] = useState(editData?.command ?? '');
  const [args, setArgs] = useState<string[]>(editData?.args?.length ? editData.args : ['']);
  const [envPairs, setEnvPairs] = useState<KVPair[]>(recordToPairs(editData?.env));
  const [url, setUrl] = useState(editData?.url ?? '');
  const [headers, setHeaders] = useState<KVPair[]>(recordToPairs(editData?.headers));
  const [preview, setPreview] = useState<McpInstallPreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maskedSecretKeys = useMemo(() => {
    return [...envPairs, ...headers]
      .filter((pair) => pair.key && pair.value === REDACTED_CAPABILITY_SECRET)
      .map((pair) => pair.key);
  }, [envPairs, headers]);

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
        setError(ownerHint(await readApiError(res as Response, '预览失败')));
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
        setError(ownerHint(await readApiError(res as Response, isEdit ? '保存失败' : '安装失败')));
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--console-overlay-backdrop)] px-4"
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
          {!readOnly && <MaskedSecretNote keys={maskedSecretKeys} />}
          <McpToolsSection tools={tools} />
          <McpPreviewSection preview={preview} />
        </div>
        {!readOnly && (
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
        )}
      </div>
    </div>
  );
}
