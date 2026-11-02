import { notFound } from 'next/navigation';
import { WorktreeNoticesPreview } from './preview';

export default function WorktreeNoticesPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <WorktreeNoticesPreview />;
}
