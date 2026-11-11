import { Suspense } from 'react';
import { AppShell } from '@/components/AppShell';
import { SessionBootstrap } from '@/components/SessionBootstrap';

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SessionBootstrap />
      <Suspense fallback={null}>
        <AppShell>{children}</AppShell>
      </Suspense>
    </>
  );
}
