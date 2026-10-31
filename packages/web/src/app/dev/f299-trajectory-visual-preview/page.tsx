import { notFound } from 'next/navigation';
import { F299TrajectoryVisualPreview } from './preview';

export default function F299TrajectoryVisualPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <F299TrajectoryVisualPreview />;
}
