import { SignalSourcesView } from '@/components/signals/SignalSourcesView';

export default function SignalSourcesPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const from = typeof searchParams.from === 'string' ? searchParams.from : null;
  return <SignalSourcesView initialReferrerThread={from} />;
}
