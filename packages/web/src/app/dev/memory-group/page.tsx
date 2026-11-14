import { notFound } from 'next/navigation';
import { MemoryGroupPreview } from './preview';

export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <MemoryGroupPreview />;
}
