import { notFound } from 'next/navigation';
import { ReplayPreview } from './ReplayPreview';

export default function ReplayPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <ReplayPreview />;
}
