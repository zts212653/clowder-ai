'use client';

import { useMemo } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { CatTokenUsage } from './CatTokenUsage';
import type { RightStatusPanelProps } from './RightStatusPanel';
import {
  collectSnapshotActiveCats,
  deriveActiveCats,
  modeLabel,
  statusLabel,
  statusTone,
  truncateId,
} from './status-helpers';

interface MobileStatusSheetProps extends RightStatusPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Bottom sheet overlay for mobile/tablet (<lg) showing key status info.
 * Desktop uses the RightStatusPanel sidebar instead.
 */
export function MobileStatusSheet({
  open,
  onClose,
  intentMode,
  targetCats,
  catStatuses,
  catInvocations,
  activeInvocations,
  hasActiveInvocation,
  threadId,
  messageSummary,
}: MobileStatusSheetProps) {
  const { getCatById } = useCatData();

  const activeCats = useMemo(() => {
    const snapshotCats = collectSnapshotActiveCats(catInvocations);
    return deriveActiveCats({ targetCats, snapshotCats, activeInvocations, hasActiveInvocation });
  }, [targetCats, catInvocations, activeInvocations, hasActiveInvocation]);

  const allParticipants = useMemo(() => {
    return [...new Set([...activeCats, ...Object.keys(catInvocations)])];
  }, [activeCats, catInvocations]);

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/30 z-40 transition-opacity lg:hidden ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div
        className={`fixed inset-x-0 bottom-0 z-50 bg-cafe-surface rounded-t-2xl shadow-2xl transition-transform duration-300 ease-out lg:hidden max-h-[70vh] overflow-y-auto safe-area-bottom ${
          open ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        {/* Handle bar + header */}
        <div className="sticky top-0 bg-cafe-surface rounded-t-2xl pt-3 pb-2 px-4 border-b border-cafe-subtle z-10">
          <div className="w-10 h-1 bg-gray-300 rounded-full mx-auto mb-2" />
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-cafe-black">状态面板</h2>
            <button
              onClick={onClose}
              className="text-cafe-muted hover:text-cafe-secondary p-1 -mr-1"
              aria-label="关闭状态面板"
            >
              <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>
          <p className="text-xs text-cafe-secondary mt-1">
            当前模式: <span className="font-medium">{modeLabel(intentMode)}</span>
          </p>
        </div>

        <div className="p-4 space-y-3">
          {/* ── Cat status ── */}
          <section className="rounded-lg border border-cafe bg-cafe-surface-elevated/70 p-3">
            <h3 className="text-xs font-semibold text-cafe-secondary mb-2">
              {activeCats.length > 0 ? '当前调用' : '猫猫状态'}
            </h3>
            {activeCats.length > 0 ? (
              <div className="space-y-2">
                {activeCats.map((catId) => {
                  const cat = getCatById(catId);
                  const dotColor = cat?.color.primary ?? '#9CA3AF';
                  const status = catStatuses[catId] ?? 'pending';
                  const inv = catInvocations[catId];
                  return (
                    <div key={catId}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: dotColor }}
                          />
                          <span className="text-xs text-cafe-secondary">{cat ? formatCatName(cat) : catId}</span>
                        </div>
                        <span className={`text-xs font-medium ${statusTone(status)}`}>{statusLabel(status)}</span>
                      </div>
                      {inv?.usage && (
                        <div className="ml-3.5 mt-1">
                          <CatTokenUsage catId={catId} usage={inv.usage} contextHealth={inv.contextHealth} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : allParticipants.length > 0 ? (
              <div className="space-y-1.5">
                {allParticipants.map((catId) => {
                  const cat = getCatById(catId);
                  return (
                    <div key={catId} className="flex items-center gap-2 text-xs text-cafe-secondary">
                      <span
                        className="inline-block h-2 w-2 rounded-full opacity-60"
                        style={{ backgroundColor: cat?.color.primary ?? '#9CA3AF' }}
                      />
                      {cat ? formatCatName(cat) : catId}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-xs text-cafe-muted">空闲</div>
            )}
          </section>

          {/* ── Message stats ── */}
          <section className="rounded-lg border border-cafe bg-cafe-surface-elevated/70 p-3">
            <h3 className="text-xs font-semibold text-cafe-secondary mb-2">消息统计</h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-cafe-secondary">
              <div>总数</div>
              <div className="text-right font-medium">{messageSummary.total}</div>
              <div>猫猫消息</div>
              <div className="text-right font-medium">{messageSummary.assistant}</div>
              <div>系统消息</div>
              <div className="text-right font-medium">{messageSummary.system}</div>
            </div>
          </section>

          {/* ── Thread info ── */}
          <section className="rounded-lg border border-cafe bg-cafe-surface-elevated/70 p-3">
            <h3 className="text-xs font-semibold text-cafe-secondary mb-2">对话信息</h3>
            <div className="text-xs text-cafe-secondary">
              Thread:{' '}
              <button
                className="text-cafe-secondary font-mono hover:text-cafe transition-colors"
                title={`点击复制: ${threadId}`}
                onClick={() => {
                  void navigator.clipboard.writeText(threadId);
                }}
              >
                {truncateId(threadId, 16)}
              </button>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
