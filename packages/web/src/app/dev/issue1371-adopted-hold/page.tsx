import { notFound } from 'next/navigation';
import { AdoptedHoldPreview } from './preview';

export default function AdoptedHoldPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <AdoptedHoldPreview />;
}
