import { notFound } from 'next/navigation';
import { SuperagentPreview } from './preview';

export default function SuperagentPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <SuperagentPreview />;
}
