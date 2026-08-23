import { notFound } from 'next/navigation';
import { F299PhaseCEvidencePreview } from './preview';

export default function F299PhaseCEvidencePreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <F299PhaseCEvidencePreview />;
}
