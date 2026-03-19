'use client';

export function ProviderProfilesSummaryCard({
  projectLabel,
  allPaths,
  activePath,
  onSwitchProject,
}: {
  projectLabel: string;
  allPaths: Array<{ path: string; label: string }>;
  activePath: string | null;
  onSwitchProject: (next: string | null) => void;
}) {
  void projectLabel;

  return (
    <div className="rounded-[20px] border border-[#F1E7DF] bg-[#FFFDFC] p-[18px]">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-semibold text-[#E29578]">系统配置 &gt; 账号配置</p>
        {allPaths.length > 1 ? (
          <select
            value={activePath ?? ''}
            onChange={(e) => onSwitchProject(e.target.value || null)}
            className="rounded-full border border-[#E8DCCF] bg-white px-3 py-1.5 text-xs text-[#5C4B42]"
          >
            {allPaths.map((option) => (
              <option key={option.path} value={option.path}>
                {option.label}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <p className="mt-2 text-[13px] leading-6 text-[#8A776B]">
        账号配置管理认证资源和 provider 级模型列表。成员侧单独选择 client、绑定 provider、再选择模型；API Key provider 不和任何 client 预绑定。
      </p>
    </div>
  );
}

export function CreateApiKeyProfileSection({
  displayName,
  baseUrl,
  apiKey,
  busy,
  onDisplayNameChange,
  onBaseUrlChange,
  onApiKeyChange,
  onCreate,
}: {
  displayName: string;
  baseUrl: string;
  apiKey: string;
  busy: boolean;
  onDisplayNameChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className="rounded-[20px] border border-[#E8C9AF] bg-[#F7EEE6] p-[18px]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-base font-bold text-[#D49266]">+ 新建 API Key 账号</h4>
          <p className="mt-1 text-xs leading-5 text-[#8A776B]">
            只填写显示名、Base URL 和 API Key。它是独立 provider 资源，不预先绑定任何 client。
          </p>
        </div>
        <span className="rounded-full bg-white/80 px-2.5 py-1 text-[11px] font-semibold text-[#B07A4C]">
          创建后去成员编辑里绑定
        </span>
      </div>
      <div className="mt-4 space-y-3">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <input
            value={displayName}
            onChange={(e) => onDisplayNameChange(e.target.value)}
            placeholder="账号显示名（例如 sponsor-1）"
            className="rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm"
          />
          <div className="rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm text-[#8A776B]">
            独立 API Key 账号（无 client 归属）
          </div>
          <input
            value={baseUrl}
            onChange={(e) => onBaseUrlChange(e.target.value)}
            placeholder="Base URL"
            className="rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm md:col-span-2"
          />
          <input
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder="API Key"
            className="rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm md:col-span-2"
          />
        </div>
        <p className="text-xs leading-5 text-[#8A776B]">
          不校验这个 Base URL / API Key 是否适配某个 client；兼容性由配置人自己负责。
        </p>
        <button
          type="button"
          onClick={onCreate}
          disabled={busy}
          className="rounded bg-[#D49266] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#c47f52] disabled:opacity-50"
        >
          {busy ? '创建中...' : '创建'}
        </button>
      </div>
    </div>
  );
}
