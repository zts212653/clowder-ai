import { HubIcon } from './hub-icons';
import type { McpInstallPreview, McpTool } from './McpConfigModalSections';
import { FormItem, FormSection } from './mcp-form-helpers';

type ConnectionStatus = 'connected' | 'disconnected' | 'timeout' | 'error' | 'unknown';

const STATUS_LABELS: Record<ConnectionStatus, { text: string; tone: string }> = {
  connected: { text: '已连接', tone: 'text-[var(--cafe-success,#22c55e)]' },
  disconnected: { text: '未连接', tone: 'text-[var(--cafe-accent)]' },
  timeout: { text: '连接超时', tone: 'text-[var(--cafe-accent)]' },
  error: { text: '连接错误', tone: 'text-[var(--cafe-accent)]' },
  unknown: { text: '未探测', tone: 'text-cafe-muted' },
};

export function McpToolsSection({
  tools,
  loading,
  connectionStatus,
  error,
  onProbe,
}: {
  tools?: McpTool[];
  loading?: boolean;
  connectionStatus?: ConnectionStatus;
  error?: string | null;
  onProbe?: () => void;
}) {
  const status = connectionStatus ? STATUS_LABELS[connectionStatus] : null;
  const hasTools = tools && tools.length > 0;
  const label = hasTools ? `工具 (${tools.length})` : '工具';

  return (
    <FormSection>
      <FormItem
        label={
          <span className="flex items-center gap-2">
            {label}
            {status && <span className={`text-label font-normal ${status.tone}`}>{status.text}</span>}
            {onProbe && (
              <button
                type="button"
                onClick={onProbe}
                disabled={loading}
                title="探测工具列表"
                className="inline-flex h-5 w-5 items-center justify-center rounded text-cafe-muted transition-colors hover:text-cafe-accent disabled:opacity-50"
              >
                <HubIcon name="refresh-cw" className={`h-3 w-3${loading ? ' animate-spin' : ''}`} />
              </button>
            )}
          </span>
        }
      >
        {loading ? (
          <div className="rounded-xl bg-[var(--console-panel-bg)] px-3 py-2.5 text-xs text-cafe-muted">
            正在探测工具列表…
          </div>
        ) : error ? (
          <div className="rounded-xl bg-[var(--console-panel-bg)] px-3 py-2.5 text-xs text-[var(--cafe-accent)]">
            {error}
          </div>
        ) : hasTools ? (
          <div className="max-h-[30vh] space-y-1 overflow-y-auto">
            {tools.map((tool) => (
              <div key={tool.name} className="rounded-xl bg-[var(--console-panel-bg)] px-3 py-2">
                <p className="text-compact font-bold text-cafe">{tool.name}</p>
                {tool.description && <p className="mt-0.5 text-label text-cafe-muted">{tool.description}</p>}
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl bg-[var(--console-panel-bg)] px-3 py-2.5 text-xs text-cafe-muted">
            未探测到工具（点击刷新按钮探测）
          </div>
        )}
      </FormItem>
    </FormSection>
  );
}

export function McpPreviewSection({ preview }: { preview: McpInstallPreview | null }) {
  if (!preview) return null;
  return (
    <FormSection>
      <FormItem label="安装预览">
        <div className="space-y-2 rounded-xl bg-[var(--console-panel-bg)] px-3 py-2.5 text-xs text-cafe-secondary">
          <p>
            标识：<span className="font-bold text-cafe">{preview.entry.id}</span>
          </p>
          <p>将更新: {preview.cliConfigsAffected.join(', ') || '无'}</p>
          {preview.willProbe && <p>安装后会探测连接状态</p>}
          {preview.risks.map((risk) => (
            <p key={risk} className="text-[var(--cafe-accent)]">
              {risk}
            </p>
          ))}
        </div>
      </FormItem>
    </FormSection>
  );
}

export function McpModalActions({
  isEdit,
  id,
  preview,
  saving,
  previewing,
  installing,
  onCancel,
  onPreview,
  onSaveOrInstall,
}: {
  isEdit: boolean;
  id: string;
  preview: McpInstallPreview | null;
  saving: boolean;
  previewing: boolean;
  installing: boolean;
  onCancel: () => void;
  onPreview: () => void;
  onSaveOrInstall: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="h-9 rounded-xl px-4 text-sm font-bold text-cafe-secondary transition hover:bg-[var(--console-hover-bg)]"
      >
        取消
      </button>
      {!isEdit && (
        <button
          type="button"
          onClick={onPreview}
          disabled={!id.trim() || previewing}
          className="h-9 rounded-xl bg-[var(--console-hover-bg)] px-4 text-sm font-bold text-cafe-secondary transition hover:text-cafe disabled:opacity-50"
        >
          {previewing ? '预览中...' : '预览'}
        </button>
      )}
      <button
        type="button"
        onClick={onSaveOrInstall}
        disabled={!id.trim() || saving || installing || (!isEdit && !preview)}
        className="h-9 rounded-xl bg-[var(--cafe-accent)] px-4 text-sm font-bold text-[var(--cafe-surface)] transition hover:bg-[var(--cafe-accent-hover)] disabled:opacity-50"
      >
        {isEdit ? (saving ? '保存中...' : '保存') : installing ? '安装中...' : '确认安装'}
      </button>
    </div>
  );
}
