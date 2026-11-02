import { notFound } from 'next/navigation';
import { ProposalJourneyPreview } from './preview';

export default function ProposalJourneyPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <ProposalJourneyPreview />;
}
