'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';

const FirstRunQuestWizard = dynamic(
  () => import('@/components/FirstRunQuestWizard').then((module) => module.FirstRunQuestWizard),
  { ssr: false },
);

export default function FirstRunOnboardingTestPage() {
  const [created, setCreated] = useState<string | null>(null);
  return (
    <main className="min-h-screen bg-cafe-surface p-8">
      {created && <p role="status">已创建对话：{created}</p>}
      <FirstRunQuestWizard open={!created} onClose={() => undefined} onCreated={(id) => setCreated(id)} />
    </main>
  );
}
