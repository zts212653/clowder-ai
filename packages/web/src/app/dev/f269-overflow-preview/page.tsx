/**
 * F269 Phase A visual-evidence fixture.
 *
 * This unlinked development-only route renders the audited production components
 * with deterministic non-production data. It exists solely to capture reproducible
 * current-state evidence before the Phase B design work changes those components.
 */

import { notFound } from 'next/navigation';
import { normalizeF269PreviewCase, normalizeF269PreviewView } from './cases';
import { F269DesignGatePreview } from './design-gate';
import { F269OverflowPreview } from './preview';

interface F269OverflowPreviewPageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default function F269OverflowPreviewPage({ searchParams }: F269OverflowPreviewPageProps) {
  if (process.env.NODE_ENV === 'production') notFound();

  if (normalizeF269PreviewView(searchParams?.view) === 'design') {
    return <F269DesignGatePreview />;
  }

  return (
    <F269OverflowPreview
      caseId={normalizeF269PreviewCase(searchParams?.case)}
      autoCapture={searchParams?.capture === '1'}
    />
  );
}
