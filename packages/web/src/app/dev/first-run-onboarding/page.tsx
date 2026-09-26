'use client';

import dynamic from 'next/dynamic';

const FirstRunQuestWizard = dynamic(
  () => import('@/components/FirstRunQuestWizard').then((module) => module.FirstRunQuestWizard),
  { ssr: false },
);

export default function FirstRunOnboardingTestPage() {
  return (
    <main className="min-h-screen bg-cafe-surface p-8">
      <FirstRunQuestWizard open onClose={() => undefined} onCreated={() => undefined} />
    </main>
  );
}
