import type { ReactNode } from 'react';
import { AttentionCostIcon, HarmfulConsumptionIcon, UnmetDemandIcon } from './RecallLedgerIcons';

export const RECALL_WINDOWS = [7, 14, 30] as const;

type MaturityLevel = 'measured' | 'estimated' | 'lower-bound' | 'no-data';

interface AxisReading {
  value: number;
  maturity: MaturityLevel;
  reason: string | null;
}

export interface ThreeAxisSnapshot {
  harmfulConsumption: AxisReading;
  unmetDemandLowerBound: AxisReading;
  attentionCost: AxisReading;
  days: number;
  from: number;
  to: number;
}

const MATURITY_LABELS: Record<MaturityLevel, { label: string; color: string }> = {
  measured: { label: '实测', color: 'text-conn-green-text' },
  estimated: { label: '估算', color: 'text-conn-amber-text' },
  'lower-bound': { label: '下界', color: 'text-conn-amber-text' },
  'no-data': { label: '无数据', color: 'text-cafe-secondary' },
};

export function ThreeAxisSection({
  snapshots,
  loading,
}: {
  snapshots: Record<number, ThreeAxisSnapshot | null>;
  loading: boolean;
}) {
  const hasAny = RECALL_WINDOWS.some((days) => snapshots[days] != null);

  if (loading && !hasAny) {
    return (
      <div data-testid="three-axis-loading" className="text-xs text-cafe-secondary animate-pulse pt-2">
        三轴加载中...
      </div>
    );
  }

  if (!hasAny) return null;

  return (
    <div data-testid="three-axis-section" className="space-y-2 pt-2 border-t border-[var(--console-border-soft)]/30">
      <span className="text-xs font-semibold text-cafe-black">三轴观测</span>

      <div className="rounded-lg bg-[var(--console-card-bg)] overflow-hidden">
        <table data-testid="three-axis-table" className="w-full text-xs">
          <thead>
            <tr className="text-cafe-secondary border-b border-[var(--console-border-soft)]/40">
              <th className="text-left px-2.5 py-1.5 font-semibold">轴</th>
              {RECALL_WINDOWS.map((days) => (
                <th key={days} className="text-right px-2.5 py-1.5 font-semibold">
                  {days}天
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <AxisRow
              label="有害消费"
              readings={RECALL_WINDOWS.map((days) => snapshots[days]?.harmfulConsumption ?? null)}
              icon={<HarmfulConsumptionIcon className="h-4 w-4 text-[var(--semantic-error)]" />}
            />
            <AxisRow
              label="错失需求"
              readings={RECALL_WINDOWS.map((days) => snapshots[days]?.unmetDemandLowerBound ?? null)}
              icon={<UnmetDemandIcon className="h-4 w-4 text-cafe-accent" />}
            />
            <AxisRow
              label="注意力成本"
              readings={RECALL_WINDOWS.map((days) => snapshots[days]?.attentionCost ?? null)}
              icon={<AttentionCostIcon className="h-4 w-4 text-conn-amber-text" />}
            />
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AxisRow({ label, readings, icon }: { label: string; readings: (AxisReading | null)[]; icon: ReactNode }) {
  return (
    <tr className="border-b border-[var(--console-border-soft)]/20 last:border-0">
      <td className="px-2.5 py-1.5 text-cafe-secondary font-medium">
        <span className="mr-1 inline-flex align-text-bottom">{icon}</span>
        {label}
      </td>
      {readings.map((reading, index) => (
        <td key={RECALL_WINDOWS[index]} className="text-right px-2.5 py-1.5">
          {reading ? <AxisCell reading={reading} /> : <span className="text-cafe-secondary">—</span>}
        </td>
      ))}
    </tr>
  );
}

function AxisCell({ reading }: { reading: AxisReading }) {
  const { label: maturityLabel, color: maturityColor } = MATURITY_LABELS[reading.maturity];
  const isNoData = reading.maturity === 'no-data';

  return (
    <div className="inline-flex flex-col items-end gap-0.5" title={reading.reason ?? undefined}>
      <span
        className={`font-semibold ${isNoData ? 'text-cafe-secondary' : 'text-cafe-black'}`}
        data-testid="axis-value"
      >
        {isNoData ? '—' : String(reading.value)}
      </span>
      <span className={`text-micro ${maturityColor}`} data-testid="axis-maturity">
        {maturityLabel}
      </span>
    </div>
  );
}
