import { notFound } from 'next/navigation';
import { DemoPreview } from './preview';

export default function DemoPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <DemoPreview />;
}
