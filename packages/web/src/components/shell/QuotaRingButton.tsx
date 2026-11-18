'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { accountRequest } from '../codex-accounts/account-request';
import { normalizeBuiltinClientIds } from '../hub-accounts.view';
import { QuotaRingIcon } from './quota-pin/QuotaRingIcon';
import { QuotaRingPopover } from './quota-pin/QuotaRingPopover';
import { quotaPinCopy } from './quota-pin/quota-pin.shell-copy';
import { buildQuotaRingModel, type QuotaFamilyId } from './quota-pin/quota-pin-model';
import { useQuotaPinPreference } from './quota-pin/quota-pin-store';
import { useQuotaRingData } from './quota-pin/use-quota-ring-data';
import { RailButton } from './RailButton';
import { useShellCopy } from './shell-copy';
import { useShellLanguage } from './shell-language';
import '../codex-accounts/codex-quota.css';

export function QuotaRingButton({ onOpenAccounts }: { onOpenAccounts: () => void }) {
  const pref = useQuotaPinPreference();
  if (!pref.pinned) return null;
  return <PinnedQuotaRingButton pref={pref} onOpenAccounts={onOpenAccounts} />;
}

function PinnedQuotaRingButton({
  pref,
  onOpenAccounts,
}: {
  pref: ReturnType<typeof useQuotaPinPreference>;
  onOpenAccounts: () => void;
}) {
  const t = useShellCopy(quotaPinCopy);
  const language = useShellLanguage();
  const pathname = usePathname() ?? '/';
  const [now, setNow] = useState(Date.now);
  const directory = useQuotaRingData({ onTurnComplete: () => setNow(Date.now()) });
  const { cats } = useCatData();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname navigation intentionally closes the popover
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    const onFocus = () => {
      setNow(Date.now());
      void directory.refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [directory.refresh]);

  const profiles = useMemo(() => normalizeBuiltinClientIds(directory.data?.providers ?? []), [directory.data]);
  const model = useMemo(
    () =>
      buildQuotaRingModel({
        profiles,
        cats,
        codexSelection: directory.selection,
        claudeSelection: directory.claudeSelection,
        agySelection: directory.agySelection,
        selectedAccountRefs: pref.selectedAccountRefs,
        now,
        language,
      }),
    [
      profiles,
      cats,
      directory.selection,
      directory.claudeSelection,
      directory.agySelection,
      pref.selectedAccountRefs,
      now,
      language,
    ],
  );

  const familyShortLabel: Record<QuotaFamilyId, string> = {
    claude: t.familyShortClaude,
    codex: t.familyShortCodex,
    agy: t.familyShortAgy,
    kimi: t.familyShortKimi,
  };

  const detailText = model.summary.hasReading
    ? model.summary.bars
        .map((bar) =>
          bar.remainingPercent !== null
            ? `${familyShortLabel[bar.family]} ${bar.remainingPercent}%`
            : `${familyShortLabel[bar.family]} —`,
        )
        .join(' · ')
    : t.railNoReading;

  const handleToggleAccount = useCallback(
    (accountId: string) => {
      const current = new Set(model.effectiveIds);
      if (current.has(accountId)) current.delete(accountId);
      else current.add(accountId);
      void pref.update({ selectedAccountRefs: [...current] });
    },
    [model.effectiveIds, pref.update],
  );

  const handleRefresh = useCallback(async () => {
    const targets = model.selectedEntries.filter((entry) => entry.canRefresh && entry.refreshKind);
    if (!targets.length) return;
    setRefreshing(true);
    setRefreshError(false);
    let failed = false;
    try {
      await Promise.all(
        targets.map(async (entry) => {
          try {
            if (!entry.refreshKind) return;
            await accountRequest(`/api/accounts/${encodeURIComponent(entry.id)}/${entry.refreshKind}/quota`, {});
          } catch {
            failed = true;
          }
        }),
      );
      await directory.refresh();
      setNow(Date.now());
      window.dispatchEvent(new Event('accounts-changed'));
    } finally {
      setRefreshError(failed);
      setRefreshing(false);
    }
  }, [model.selectedEntries, directory.refresh]);

  return (
    <>
      <RailButton
        ref={buttonRef}
        ariaLabel={t.railAccessible(detailText)}
        tip={t.railTip}
        tipDetail={detailText}
        selected={open}
        ariaExpanded={open}
        ariaHasPopup="dialog"
        disableTip={open}
        onClick={() => {
          if (!open) {
            setNow(Date.now());
            void directory.refresh();
          }
          setOpen((wasOpen) => !wasOpen);
        }}
        testId="quota-ring-button"
      >
        <QuotaRingIcon summary={model.summary} className="h-5 w-5" />
      </RailButton>
      {open && (
        <QuotaRingPopover
          anchor={buttonRef}
          allEntries={model.allEntries}
          effectiveIds={model.effectiveIds}
          selectedEntries={model.selectedEntries}
          refreshing={refreshing}
          refreshError={refreshError}
          onRefresh={() => void handleRefresh()}
          onToggleAccount={handleToggleAccount}
          onManageAccounts={() => {
            setOpen(false);
            onOpenAccounts();
          }}
          onUnpin={() => {
            setOpen(false);
            void pref.update({ pinned: false });
          }}
          onClose={() => {
            setOpen(false);
            buttonRef.current?.focus();
          }}
        />
      )}
    </>
  );
}
