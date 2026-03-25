'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { HubConnectorConfigTab } from './HubConnectorConfigTab';
import HubPermissionsTab from './HubPermissionsTab';
import { HubIcon } from './icons/HubIcon';
import { formatRelativeTime } from './ThreadSidebar/thread-utils';

const CONNECTOR_LABELS: Record<string, string> = {
  feishu: '飞书',
  telegram: 'Telegram',
  wechat: '微信',
  slack: 'Slack',
  discord: 'Discord',
};

type HubTab = 'threads' | 'config' | 'permissions';

interface HubThreadSummary {
  id: string;
  title?: string;
  connectorId?: string;
  externalChatId?: string;
  createdAt?: number;
  lastCommandAt?: number;
}

interface HubListModalProps {
  open: boolean;
  onClose: () => void;
  currentThreadId?: string;
}

export function HubListModal({ open, onClose, currentThreadId }: HubListModalProps) {
  const router = useRouter();
  const [hubThreads, setHubThreads] = useState<HubThreadSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<HubTab>('threads');

  const fetchHubThreads = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/connector/hub-threads');
      if (!res.ok) return;
      const data = await res.json();
      setHubThreads(data.threads ?? []);
    } catch {
      // fall through
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      fetchHubThreads();
      setActiveTab('threads');
    }
  }, [open, fetchHubThreads]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const handleNavigate = (threadId: string) => {
    router.push(`/thread/${threadId}`);
    onClose();
  };

  const grouped = new Map<string, HubThreadSummary[]>();
  for (const t of hubThreads) {
    const key = t.connectorId ?? 'unknown';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(t);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      data-testid="hub-list-modal"
    >
      <div className="bg-white rounded-2xl shadow-xl w-[520px] max-h-[80vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2.5">
            <HubIcon className="w-5 h-5 text-blue-600" />
            <span className="text-lg font-semibold text-gray-900">IM Hub</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            data-testid="hub-list-close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex border-b border-gray-100 px-6" data-testid="hub-tabs">
          <button
            type="button"
            onClick={() => setActiveTab('threads')}
            className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
              activeTab === 'threads' ? 'text-blue-600' : 'text-gray-500 hover:text-gray-700'
            }`}
            data-testid="hub-tab-threads"
          >
            系统对话中心
            {activeTab === 'threads' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 rounded-full" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('config')}
            className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
              activeTab === 'config' ? 'text-blue-600' : 'text-gray-500 hover:text-gray-700'
            }`}
            data-testid="hub-tab-config"
          >
            平台配置
            {activeTab === 'config' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 rounded-full" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('permissions')}
            className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
              activeTab === 'permissions' ? 'text-blue-600' : 'text-gray-500 hover:text-gray-700'
            }`}
            data-testid="hub-tab-permissions"
          >
            群聊权限
            {activeTab === 'permissions' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 rounded-full" />
            )}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {activeTab === 'permissions' ? (
            <HubPermissionsTab />
          ) : activeTab === 'threads' ? (
            <div className="space-y-4">
              {isLoading ? (
                <p className="text-center text-gray-400 py-8 text-sm">加载中...</p>
              ) : hubThreads.length === 0 ? (
                <p className="text-center text-gray-400 py-8 text-sm">
                  还没有 IM Hub。从飞书/Telegram 发送消息建立绑定后，命令将自动路由到专用 Hub thread。
                </p>
              ) : (
                Array.from(grouped.entries()).map(([connectorId, threads]) => (
                  <div key={connectorId}>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                      {CONNECTOR_LABELS[connectorId] ?? connectorId} Hub
                    </div>
                    <div className="space-y-2">
                      {threads.map((t) => {
                        const isCurrent = t.id === currentThreadId;
                        return (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => handleNavigate(t.id)}
                            disabled={isCurrent}
                            className={`w-full text-left p-3 rounded-xl border transition-colors ${
                              isCurrent
                                ? 'border-blue-300 bg-blue-50 opacity-60 cursor-default'
                                : 'border-gray-200 bg-gray-50 hover:bg-gray-100'
                            }`}
                            data-testid={`hub-item-${t.id}`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-[15px] font-medium text-gray-900">
                                {t.title ?? `${CONNECTOR_LABELS[connectorId] ?? connectorId} IM Hub`}
                              </span>
                              {isCurrent && (
                                <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-blue-100 text-blue-700">
                                  当前
                                </span>
                              )}
                            </div>
                            {t.externalChatId && (
                              <div className="text-xs text-gray-400 mt-1 truncate">{t.externalChatId}</div>
                            )}
                            {t.lastCommandAt && (
                              <div className="text-xs text-gray-400 mt-0.5">
                                最近命令 {formatRelativeTime(t.lastCommandAt)}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : (
            <HubConnectorConfigTab />
          )}
        </div>
      </div>
    </div>
  );
}
