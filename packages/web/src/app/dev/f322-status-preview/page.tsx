import { notFound } from 'next/navigation';
import { StatusPreview } from './StatusPreview';

export default function StatusPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <StatusPreview />;
}
