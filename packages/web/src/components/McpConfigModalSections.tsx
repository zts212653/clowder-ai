import { HubIcon } from './hub-icons';
import { DynamicKVList, DynamicList, FormItem, FormSection, formInputClass, type KVPair } from './mcp-form-helpers';

export type McpTransport = 'stdio' | 'streamableHttp';

export interface McpInstallPreview {
  entry: { id: string; type: string; enabled: boolean; source: string };
  cliConfigsAffected: string[];
  willProbe: boolean;
  risks: string[];
}

export interface McpEditData {
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  resolver?: string;
  resolvedCommand?: string;
  resolvedArgs?: string[];
  envKeys?: string[];
}

export interface McpTool {
  name: string;
  description?: string;
}

export function McpModalHeader({ title, subtitle, onClose }: { title: string; subtitle: string; onClose: () => void }) {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1 space-y-2">
        <h2 className="text-lg font-bold text-cafe">{title}</h2>
        <p className="text-xs text-cafe-secondary">{subtitle}</p>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-cafe-muted transition hover:bg-[var(--console-modal-close-bg)] hover:text-[var(--console-modal-close-fg)]"
      >
        <HubIcon name="x" className="h-4 w-4" />
      </button>
    </div>
  );
}

export function McpIdentitySection({
  id,
  isEdit,
  transport,
  onIdChange,
  onTransportChange,
}: {
  id: string;
  isEdit: boolean;
  transport: McpTransport;
  onIdChange: (value: string) => void;
  onTransportChange: (value: McpTransport) => void;
}) {
  return (
    <FormSection>
      <FormItem label="名称">
        <input
          type="text"
          value={id}
          onChange={(event) => onIdChange(event.target.value)}
          placeholder="MCP 服务名称"
          className={`${formInputClass} disabled:opacity-60`}
          disabled={isEdit}
        />
      </FormItem>
      {!isEdit ? (
        <EditableTransportSelector value={transport} onChange={onTransportChange} />
      ) : (
        <ReadonlyTransport transport={transport} />
      )}
    </FormSection>
  );
}

function EditableTransportSelector({
  value,
  onChange,
}: {
  value: McpTransport;
  onChange: (value: McpTransport) => void;
}) {
  return (
    <FormItem label="传输方式">
      <div className="flex h-10 gap-1 rounded-xl bg-[var(--console-field-bg)] p-1">
        <TransportButton active={value === 'stdio'} onClick={() => onChange('stdio')}>
          STDIO
        </TransportButton>
        <TransportButton active={value === 'streamableHttp'} onClick={() => onChange('streamableHttp')}>
          流式 HTTP
        </TransportButton>
      </div>
    </FormItem>
  );
}

function TransportButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      className={`flex h-8 flex-1 items-center justify-center rounded-lg text-xs font-bold transition-colors ${
        active ? 'bg-[var(--cafe-accent)] text-[var(--cafe-surface)]' : 'text-cafe-secondary'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ReadonlyTransport({ transport }: { transport: McpTransport }) {
  return (
    <FormItem label="传输方式">
      <div className="flex h-10 items-center rounded-xl bg-[var(--console-field-bg)] px-3 text-compact font-bold text-cafe-secondary">
        {transport === 'streamableHttp' ? '流式 HTTP' : 'STDIO'}
      </div>
    </FormItem>
  );
}

export function McpResolverSection({ resolver }: { resolver?: string }) {
  if (!resolver) return null;
  return (
    <FormSection>
      <FormItem label="解析器">
        <div className="console-pill px-3 py-1.5 text-xs text-cafe-secondary">{resolver}</div>
      </FormItem>
    </FormSection>
  );
}

export function McpTransportFields(props: {
  transport: McpTransport;
  isEdit: boolean;
  command: string;
  args: string[];
  envPairs: KVPair[];
  url: string;
  headers: KVPair[];
  editData?: McpEditData;
  onCommandChange: (value: string) => void;
  onArgsChange: (values: string[]) => void;
  onEnvPairsChange: (pairs: KVPair[]) => void;
  onUrlChange: (value: string) => void;
  onHeadersChange: (pairs: KVPair[]) => void;
}) {
  if (props.transport === 'streamableHttp') return <McpHttpFields {...props} />;
  return <McpStdioFields {...props} />;
}

function McpStdioFields({
  isEdit,
  command,
  args,
  envPairs,
  onCommandChange,
  onArgsChange,
  onEnvPairsChange,
}: Parameters<typeof McpTransportFields>[0]) {
  return (
    <FormSection>
      <FormItem label="启动命令">
        <input
          type="text"
          value={command}
          onChange={(event) => onCommandChange(event.target.value)}
          placeholder={isEdit ? '留空保留现有命令' : '例如 npx'}
          className={formInputClass}
        />
      </FormItem>
      <FormItem label="参数">
        <DynamicList
          values={args}
          placeholder={isEdit ? '留空保留现有参数' : ''}
          onChange={onArgsChange}
          addLabel="参数"
        />
      </FormItem>
      <FormItem label="环境变量">
        <DynamicKVList
          pairs={envPairs}
          onChange={onEnvPairsChange}
          addLabel="环境变量"
          valuePlaceholder={isEdit ? '留空保留，填写则覆盖' : '值'}
          sensitive
        />
      </FormItem>
    </FormSection>
  );
}

function McpHttpFields({
  isEdit,
  url,
  headers,
  onUrlChange,
  onHeadersChange,
}: Parameters<typeof McpTransportFields>[0]) {
  return (
    <FormSection>
      <FormItem label="URL">
        <input
          type="text"
          value={url}
          onChange={(event) => onUrlChange(event.target.value)}
          placeholder={isEdit ? '留空保留现有 URL' : 'https://mcp.example.com/mcp'}
          className={formInputClass}
        />
      </FormItem>
      <FormItem label="标头">
        <DynamicKVList
          pairs={headers}
          onChange={onHeadersChange}
          addLabel="标头"
          valuePlaceholder={isEdit ? '留空保留，填写则覆盖' : '值'}
          sensitive
        />
      </FormItem>
    </FormSection>
  );
}

export function MaskedSecretNote({ keys }: { keys: string[] }) {
  if (keys.length === 0) return null;
  return (
    <p className="px-3 text-label text-cafe-muted">
      已遮罩字段 {keys.join(', ')} 保存时会省略；只会写入你本次填写的新值。
    </p>
  );
}
