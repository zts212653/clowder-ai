import { notFound } from 'next/navigation';
import { SearchGroupPreview } from './preview';

export default function SearchGroupPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <SearchGroupPreview />;
}
