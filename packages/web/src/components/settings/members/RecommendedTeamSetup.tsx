'use client';

import { useEffect } from 'react';
import { NativePartnerCard } from '../../first-run-quest/NativePartnerCard';
import { nativePartnerSelectable } from '../../first-run-quest/native-onboarding';
import { needsExistingDshRepair } from '../../first-run-quest/native-partner-persistence';
import { useNativeOnboarding } from '../../first-run-quest/useNativeOnboarding';
import { finishOnboardingNavigation } from '../../onboarding-demo/onboarding-performance';

export function RecommendedTeamSetup({
  onCreated,
  onManual,
  onBack,
}: {
  onCreated: () => void | Promise<void>;
  onManual: () => void;
  onBack: () => void;
}) {
  const setup = useNativeOnboarding(true, onCreated, 'members');
  const { draft, loading, busy, error, errorStage } = setup;
  useEffect(() => finishOnboardingNavigation('team-setup', 'mounted'), []);
  useEffect(() => {
    if (!loading) finishOnboardingNavigation('team-setup', 'ready');
  }, [loading]);
  const available = draft?.partners.filter(nativePartnerSelectable) ?? [];
  const unavailable = draft?.partners.filter((p) => !available.includes(p)) ?? [];
  const selected = available.filter((p) => p.selected);
  const pending = selected.filter((p) => needsExistingDshRepair(p) || (!p.existingId && !draft?.created[p.id]));
  const repairing = pending.some(needsExistingDshRepair);
  const invalidSelection = selected.some((p) => !p.form.displayName.trim() || Boolean(p.recoverable && !p.existingId));
  const card = (partner: NonNullable<typeof draft>['partners'][number]) => (
    <NativePartnerCard
      key={partner.id}
      partner={partner}
      compact
      created={!needsExistingDshRepair(partner) && Boolean(partner.existingId || draft?.created[partner.id])}
      disabled={Boolean(busy)}
      patch={(change) => setup.patchPartner(partner.id, change)}
    />
  );
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 pb-10 text-cafe" data-testid="recommended-team-setup">
      <header>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={onBack}
          className="mb-3 min-h-10 text-sm text-cafe-accent"
        >
          ← 成员与运行时
        </button>
        <h1 className="text-2xl font-semibold">创建你的猫猫团队</h1>
        <p className="mt-3 text-sm leading-6 text-cafe-secondary">
          根据这台电脑上的工具，为你准备了默认伙伴。保留推荐，一键加入；以后随时可以调整。
        </p>
      </header>
      <section className="rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">
            {loading ? '正在准备推荐…' : `推荐伙伴${available.length ? ` · ${available.length} 位` : ''}`}
          </h2>
          <button
            type="button"
            disabled={loading || Boolean(busy)}
            onClick={setup.reload}
            className="min-h-10 text-sm text-cafe-accent disabled:opacity-50"
          >
            重新检测
          </button>
        </div>
        {loading ? (
          <p role="status" className="py-8 text-sm text-cafe-secondary">
            正在检测本机工具并匹配角色…
          </p>
        ) : errorStage === 'discovery' ? (
          <div role="alert" className="rounded-xl bg-conn-red-bg p-4 text-sm text-conn-red-text">
            <p className="font-semibold">暂时无法检测工具</p>
            <p className="mt-2">{error}</p>
            <p className="mt-2">请检查服务连接后重新检测。已有选择会保留。</p>
          </div>
        ) : (
          <>
            <p className="mb-5 text-sm leading-6 text-cafe-secondary">
              模型和思考强度默认跟随工具。按工具能力检查本机登录状态，创建不会调用模型；实际连接仍需验证额度和网络。
            </p>
            {available.length ? (
              <div className="grid gap-3 lg:grid-cols-3">{available.map(card)}</div>
            ) : (
              <div className="rounded-xl bg-[var(--console-panel-bg)] p-5">
                <h3 className="font-semibold">还没有找到可加入的工具</h3>
                <p className="mt-2 text-sm leading-6 text-cafe-secondary">
                  安装并配置支持的工具后重新检测，或手动接入已有工具。刚才的协作演示仍可随时重看。
                </p>
              </div>
            )}
            {unavailable.length > 0 && (
              <details className="mt-5 border-t border-[var(--console-border-soft)] pt-4" open={!available.length}>
                <summary className="cursor-pointer text-sm text-cafe-secondary">其他工具与安装帮助</summary>
                <div className="mt-4 space-y-3">{unavailable.map(card)}</div>
              </details>
            )}
          </>
        )}
      </section>
      {errorStage === 'save' && (
        <div role="alert" className="rounded-xl bg-conn-red-bg p-4 text-sm text-conn-red-text">
          <p>{error}</p>
          <p className="mt-2">已经加入的伙伴已保留，继续创建只处理剩余伙伴。</p>
        </div>
      )}
      <footer className="sticky bottom-3 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-4 shadow-lg">
        <div className="text-sm">
          <p role="status">
            {busy ||
              (pending.length
                ? repairing
                  ? `已准备 ${pending.length} 位伙伴配置，保存后生效`
                  : `已为你选好 ${pending.length} 位新伙伴`
                : selected.length
                  ? '所选伙伴已加入团队'
                  : '可以选择一位、多位，或暂不创建')}
          </p>
          <button type="button" disabled={Boolean(busy)} onClick={onManual} className="mt-2 min-h-8 text-cafe-accent">
            手动创建单个伙伴
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={onBack}
            className="min-h-11 px-3 text-sm text-cafe-secondary"
          >
            暂不创建
          </button>
          {selected.length > 0 && (
            <button
              type="button"
              disabled={loading || Boolean(busy) || errorStage === 'discovery' || !selected.length || invalidSelection}
              onClick={() => void setup.start()}
              className="min-h-11 rounded-full bg-cafe-accent px-6 text-sm font-semibold text-[var(--cafe-surface)] disabled:opacity-50"
            >
              {busy
                ? repairing
                  ? '正在保存…'
                  : '正在创建…'
                : pending.length
                  ? repairing
                    ? `保存 ${pending.length} 位伙伴配置`
                    : `${errorStage === 'save' ? '继续创建' : '一键创建'} ${pending.length} 位伙伴`
                  : '查看我的团队'}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
