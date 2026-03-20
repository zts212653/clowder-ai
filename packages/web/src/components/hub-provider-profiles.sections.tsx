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
        每个账号可添加或删除模型。
      </p>
    </div>
  );
}

export function CreateApiKeyProfileSection({
  displayName,
  baseUrl,
  apiKey,
  modelsText,
  busy,
  onDisplayNameChange,
  onBaseUrlChange,
  onApiKeyChange,
  onModelsTextChange,
  onCreate,
}: {
  displayName: string;
  baseUrl: string;
  apiKey: string;
  modelsText: string;
  busy: boolean;
  onDisplayNameChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onModelsTextChange: (value: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className="rounded-[20px] border border-[#E8C9AF] bg-[#F7EEE6] p-[18px]">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-base font-bold text-[#D49266]">+ 新建 API Key 账号</h4>
      </div>
      <div className="mt-4 space-y-3">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <input
            value={displayName}
            onChange={(e) => onDisplayNameChange(e.target.value)}
            placeholder="账号显示名（例如 my-glm）"
            className="rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm"
          />
          <div className="rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm text-[#8A776B]">
            API Key 账号
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
          <textarea
            aria-label="Supported Models"
            value={modelsText}
            onChange={(e) => onModelsTextChange(e.target.value)}
            placeholder="支持模型（逗号或换行分隔）"
            className="min-h-[92px] rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm md:col-span-2"
          />
        </div>
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
