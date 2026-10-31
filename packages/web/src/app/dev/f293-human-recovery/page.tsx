import { notFound } from 'next/navigation';
import { HumanRecoveryPreview } from './preview';

export default function HumanRecoveryPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <HumanRecoveryPreview />;
}
