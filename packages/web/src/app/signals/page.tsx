import { Suspense } from 'react';
import { SignalInboxView } from '@/components/signals/SignalInboxView';

export default function SignalsPage() {
  return (
    <Suspense>
      <SignalInboxView />
    </Suspense>
  );
}
