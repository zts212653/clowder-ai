import { Suspense } from 'react';
import { SignalInboxView } from '@/components/signals/SignalInboxView';

export default function SignalsPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const from = typeof searchParams.from === 'string' ? searchParams.from : null;
  return (
    <Suspense>
      <SignalInboxView initialReferrerThread={from} />
    </Suspense>
  );
}
