import { notFound } from 'next/navigation';
import { F246HistoryDetailsPreview } from './preview';

export default function F246HistoryDetailsPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <F246HistoryDetailsPreview />;
}
