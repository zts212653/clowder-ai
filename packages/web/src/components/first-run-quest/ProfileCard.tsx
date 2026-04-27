'use client';

import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { ProfileItem } from '../hub-accounts.types';

interface ProfileCardProps {
  profile: ProfileItem;
  isSelected: boolean;
  isExpanded: boolean;
  selectedModel: string;
  testing: boolean;
  testResult: { ok: boolean; message?: string } | null;
  onSelect: () => void;
  onModelSelect: (model: string) => void;
  onTest: () => void;
  onProfileRefresh: () => void;
  onEdit: () => void;
}

const PROVIDER_DEFAULT_HOST: Record<string, string> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  google: 'generativelanguage.googleapis.com',
};

export function ProfileCard({
  profile,
  isSelected,
  isExpanded,
  selectedModel,
  testing,
  testResult,
  onSelect,
  onModelSelect,
  onTest,
  onProfileRefresh,
  onEdit,
}: ProfileCardProps) {
  const [addingModel, setAddingModel] = useState(false);
  const [newModel, setNewModel] = useState('');

  const models = profile.models?.map((m) => m.trim()).filter(Boolean) ?? [];

  const borderClass = !isSelected
    ? 'border-gray-200 hover:border-amber-200'
    : testResult?.ok
      ? 'border-green-400 bg-green-50/40 shadow-sm'
      : testResult && !testResult.ok
        ? 'border-red-300 bg-red-50/30 shadow-sm'
        : 'border-amber-400 bg-amber-50/60 shadow-sm';

  const [modelError, setModelError] = useState('');

  const updateModels = async (updated: string[]): Promise<boolean> => {
    setModelError('');
    const res = await apiFetch(`/api/accounts/${encodeURIComponent(profile.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: updated }),
    });
    if (res.ok) {
      onProfileRefresh();
      return true;
    }
    setModelError('模型更新失败，请重试');
    return false;
  };

  const handleAdd = async () => {
    const name = newModel.trim();
    if (!name || models.includes(name)) return;
    const ok = await updateModels([...models, name]);
    if (!ok) return;
    onModelSelect(name);
    setNewModel('');
    setAddingModel(false);
  };

  const handleRemove = async (m: string) => {
    const ok = await updateModels(models.filter((x) => x !== m));
    if (!ok) return;
    if (selectedModel === m) onModelSelect(models.find((x) => x !== m) ?? '');
  };

  return (
    <div className={`rounded-lg border transition-all duration-200 ${borderClass}`}>
      <button type="button" onClick={onSelect} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm">
        <span className={`h-2 w-2 rounded-full ${isSelected ? 'bg-amber-500' : 'bg-gray-300'}`} />
        <span className="flex-1 font-medium text-gray-900">{profile.displayName ?? profile.name ?? profile.id}</span>
        <span className="text-xs text-gray-400">{profile.authType === 'oauth' ? 'OAuth' : 'API Key'}</span>
        <svg
          className={`h-3 w-3 text-gray-400 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isExpanded && (
        <div className="space-y-2 border-t border-amber-100 px-3 py-2">
          <div className="flex items-start justify-between">
            <div className="space-y-0.5">
              {profile.authType === 'oauth' ? (
                <p className="text-xs text-gray-500">OAuth 认证账号</p>
              ) : (
                <>
                  <p className="truncate text-[11px] text-gray-400">
                    {profile.baseUrl || (profile.clientId && PROVIDER_DEFAULT_HOST[profile.clientId]) || ''}
                  </p>
                  <p className="text-xs text-gray-500">API Key: {profile.hasApiKey ? '已配置' : '未配置'}</p>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              className="shrink-0 text-[11px] text-amber-500 hover:text-amber-700"
            >
              编辑
            </button>
          </div>

          {/* Model chips with add/delete */}
          <div>
            <p className="mb-1 text-[11px] font-medium text-gray-500">模型</p>
            <div className="flex flex-wrap gap-1.5">
              {models.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => onModelSelect(m)}
                  className={`group flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                    selectedModel === m
                      ? 'border-purple-400 bg-purple-50 text-purple-700'
                      : 'border-gray-200 text-gray-500 hover:border-purple-200'
                  }`}
                >
                  {m}
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemove(m);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.stopPropagation();
                        handleRemove(m);
                      }
                    }}
                    className="hidden text-gray-300 hover:text-red-400 group-hover:inline"
                  >
                    ×
                  </span>
                </button>
              ))}
              {addingModel ? (
                <span className="flex items-center gap-1">
                  <input
                    value={newModel}
                    onChange={(e) => setNewModel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAdd();
                      if (e.key === 'Escape') setAddingModel(false);
                    }}
                    placeholder="model-id"
                    className="w-36 rounded border border-purple-300 px-2 py-0.5 text-xs"
                  />
                  <button type="button" onClick={handleAdd} className="text-xs text-purple-600 hover:text-purple-800">
                    ✓
                  </button>
                  <button
                    type="button"
                    onClick={() => setAddingModel(false)}
                    className="text-xs text-gray-400 hover:text-gray-600"
                  >
                    ✕
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setAddingModel(true)}
                  className="rounded-lg border border-dashed border-gray-300 px-2.5 py-1 text-xs text-gray-400 hover:border-purple-300 hover:text-purple-500"
                >
                  + 添加
                </button>
              )}
            </div>
            {models.length === 0 && !addingModel && (
              <p className="mt-1 text-[11px] text-gray-400">{'暂无模型，请点击"+ 添加"后测试'}</p>
            )}
            {modelError && <p className="mt-1 text-[11px] text-red-500">{modelError}</p>}
          </div>

          {/* Test button */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onTest}
              disabled={testing || !selectedModel}
              className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-medium transition-all ${
                testing
                  ? 'cursor-wait border-amber-300 bg-amber-50 text-amber-600'
                  : testResult?.ok
                    ? 'border-green-400 bg-green-50 text-green-700'
                    : 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100'
              } disabled:opacity-60`}
            >
              {testing && (
                <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
              )}
              {testing ? '测试中' : testResult?.ok ? '已通过' : '测试连接'}
            </button>
            {testResult && (
              <span className={`text-xs ${testResult.ok ? 'text-green-600' : 'text-red-500'}`}>
                {testResult.message}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
