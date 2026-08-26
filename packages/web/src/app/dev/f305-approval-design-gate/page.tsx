import { notFound } from 'next/navigation';
import { F305ApprovalDesignGatePreview } from './preview';

export default function F305ApprovalDesignGatePage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <F305ApprovalDesignGatePreview />;
}
