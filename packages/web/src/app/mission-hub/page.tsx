import { MissionControlPage } from '@/components/mission-control/MissionControlPage';

export default function MissionHubPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const from = typeof searchParams.from === 'string' ? searchParams.from : null;
  return <MissionControlPage initialReferrerThread={from} />;
}
