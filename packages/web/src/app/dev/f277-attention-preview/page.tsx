import { notFound } from 'next/navigation';
import { F277AttentionPreview } from './preview';

export default function F277AttentionPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <F277AttentionPreview />;
}
