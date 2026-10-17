'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { prepareFirstRunEntry } from '../../first-run-quest/prepareFirstRunEntry';
import { MemberSettingsPage } from './MemberSettingsPage';
import { RecommendedTeamSetup } from './RecommendedTeamSetup';

/** Keep first-run selection stable while a partially created roster refreshes. */
export function MemberCreationPage({
  onTeamCreated,
  ...props
}: Omit<Parameters<typeof MemberSettingsPage>[0], 'cat'> & { onTeamCreated: () => Promise<void> }) {
  const params = useSearchParams();
  const router = useRouter();
  const { hasFetched, isLoading, refresh } = useCatData();
  const initialRosterEmpty = useRef<boolean | null>(hasFetched && !isLoading ? props.cats.length === 0 : null);
  useEffect(() => {
    if (initialRosterEmpty.current === null && hasFetched && !isLoading)
      initialRosterEmpty.current = props.cats.length === 0;
  }, [hasFetched, isLoading, props.cats.length]);
  const decided = useRef(false);
  const [mode, setMode] = useState<'team' | 'manual' | 'pending' | 'existing'>(
    params.get('manual') === '1' || params.get('view') !== 'setup'
      ? 'manual'
      : params.get('resume') === '1'
        ? 'team'
        : 'pending',
  );
  const chooseManual = () => {
    setMode('manual');
    const next = new URLSearchParams(params.toString());
    next.set('view', 'add');
    next.set('manual', '1');
    next.delete('resume');
    router.replace(`/settings?${next.toString()}`, { scroll: false });
  };
  useEffect(() => {
    if (mode !== 'pending' || !hasFetched || decided.current) return;
    decided.current = true;
    if (props.cats.length) {
      setMode('existing');
      props.onBack();
    } else {
      setMode('team');
      // Keep an explicitly started zero-role journey resumable after partial creation.
      const next = new URLSearchParams(params.toString());
      next.set('resume', '1');
      router.replace(`/settings?${next.toString()}`, { scroll: false });
    }
  }, [mode, hasFetched, props.cats.length, props.onBack, params, router]);
  if (mode === 'existing') return null;
  if (mode === 'pending')
    return (
      <div role="status" className="p-6 text-sm">
        {isLoading ? '正在读取已有伙伴…' : '暂时无法读取已有伙伴。'}
        {!isLoading && (
          <button type="button" onClick={() => void refresh()} className="ml-4 text-cafe-accent">
            重试
          </button>
        )}
        <button type="button" onClick={chooseManual} className="ml-4 text-cafe-accent">
          手动创建单个伙伴
        </button>
      </div>
    );
  if (mode === 'manual')
    return (
      <MemberSettingsPage
        {...props}
        cat={null}
        onBeforeCreate={async () => {
          if (initialRosterEmpty.current) await prepareFirstRunEntry();
        }}
      />
    );
  return <RecommendedTeamSetup onBack={props.onBack} onCreated={onTeamCreated} onManual={chooseManual} />;
}
