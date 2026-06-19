'use client';

/**
 * ConnectorPluginInstallButton — F240 Phase B
 *
 * Upload button + plugin-dev-doc link, rendered at page-top-right
 * inside HubConnectorConfigTab. Self-contained upload state.
 *
 * macOS file-picker fix: no `accept` filter (macOS cannot match
 * compound extensions like ".tar.gz"). Validation is done in JS
 * after selection instead.
 */

import { useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface Props {
  onInstalled?: () => void;
}

export function ConnectorPluginInstallButton({ onInstalled }: Props) {
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (file: File) => {
    if (!file.name.endsWith('.tar.gz') && !file.name.endsWith('.tgz')) {
      setMessage({ type: 'error', text: '请选择 .tar.gz 或 .tgz 格式的插件包' });
      return;
    }
    setUploading(true);
    setMessage(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await apiFetch('/api/connectors/plugins/install', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: 'success', text: `${data.action === 'updated' ? '更新' : '安装'}成功: ${data.id}` });
        onInstalled?.();
      } else {
        setMessage({ type: 'error', text: data.error ?? '安装失败' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: `上传失败: ${(err as Error).message}` });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <label
        className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-cafe-border px-3 py-1.5 text-xs font-medium text-cafe-secondary transition-colors hover:bg-cafe-hover ${uploading ? 'pointer-events-none opacity-50' : ''}`}
        title="上传 .tar.gz / .tgz 插件包"
      >
        <UploadIcon />
        {uploading ? '安装中...' : '安装 IM Connector'}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleUpload(f);
          }}
        />
      </label>
      <a
        href="/docs/guides/im-connector-dev-guide.md"
        download="im-connector-dev-guide.md"
        className="inline-flex items-center gap-1 text-xs text-cafe-muted underline decoration-cafe-border underline-offset-2 transition-colors hover:text-cafe-secondary"
      >
        <DocIcon />
        IM Connector 开发文档
      </a>
      {message && (
        <div
          className={`mt-1 rounded-lg px-3 py-2 text-xs ${
            message.type === 'success'
              ? 'bg-conn-emerald-bg text-conn-emerald-text border border-conn-emerald-ring'
              : 'bg-conn-red-bg text-conn-red-text border border-conn-red-ring'
          }`}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}

function UploadIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="h-3.5 w-3.5"
      aria-label="上传"
    >
      <path d="M8 2a.75.75 0 0 1 .75.75v5.69l1.72-1.72a.75.75 0 1 1 1.06 1.06l-3 3a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 0 1 1.06-1.06l1.72 1.72V2.75A.75.75 0 0 1 8 2Z" />
      <path d="M3.5 9.75a.75.75 0 0 0-1.5 0v1.5A2.75 2.75 0 0 0 4.75 14h6.5A2.75 2.75 0 0 0 14 11.25v-1.5a.75.75 0 0 0-1.5 0v1.5c0 .69-.56 1.25-1.25 1.25h-6.5c-.69 0-1.25-.56-1.25-1.25v-1.5Z" />
    </svg>
  );
}

function DocIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="h-3 w-3"
      aria-label="文档"
    >
      <path d="M4 2a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6.414A2 2 0 0 0 13.414 5L11 2.586A2 2 0 0 0 9.586 2H4Zm5 2.414L12.586 8H10a1 1 0 0 1-1-1V4.414ZM4.5 10a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1H5a.5.5 0 0 1-.5-.5Zm0 2a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 0 1H5a.5.5 0 0 1-.5-.5Z" />
    </svg>
  );
}
