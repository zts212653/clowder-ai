import type { CompanionIdentitySnapshotV1 } from '@cat-cafe/shared';
import { projectCompanionIdentity } from '@cat-cafe/shared';
import { useCatData } from '@/hooks/useCatData';
import { CatAvatar } from '../CatAvatar';

const LEGACY_PORTRAIT_IDS: Record<string, string> = {
  'fable-5': 'claude-fable-5',
  'codex-sol': 'codex',
  'codex6-sol': 'codex',
};

/** One mark is used in the current Hub panel and in saved Live messages. */
export function CompanionAvatar({
  catId,
  partnerName,
  size = 32,
  status,
}: {
  catId: string;
  partnerName?: string;
  size?: number;
  status?: 'streaming' | 'error';
}) {
  const { getCatById } = useCatData();
  const portraitCatId = getCatById(catId) ? catId : (LEGACY_PORTRAIT_IDS[catId] ?? catId);
  return (
    <span
      data-testid="companion-avatar"
      data-companion-cat-id={catId}
      role="img"
      aria-label={`${partnerName ?? catId}的猫猫球伴随头像`}
      className="relative inline-flex"
    >
      <CatAvatar catId={portraitCatId} size={size} status={status} />
      <span
        aria-hidden="true"
        className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border border-cafe bg-cafe-accent text-micro font-bold leading-none text-[var(--cafe-accent-foreground)]"
      >
        球
      </span>
    </span>
  );
}

/** A saved Live message keeps the selected cat's face while the message keeps its real author. */
export function CompanionMessageAvatar({ identity }: { identity: CompanionIdentitySnapshotV1 }) {
  const view = projectCompanionIdentity(identity);
  return <CompanionAvatar catId={view.avatarCatId} partnerName={identity.partner.displayName} />;
}

export function CompanionMessageIdentity({
  identity,
  authorName,
}: {
  identity: CompanionIdentitySnapshotV1;
  authorName: string;
}) {
  const view = projectCompanionIdentity(identity);
  return (
    <details data-testid="companion-message-identity" className="text-micro text-cafe-muted">
      <summary className="cursor-pointer">
        当时由{identity.partner.displayName}陪伴 · 实际发言：{authorName}
      </summary>
      <div className="mt-1 pl-3">
        <p>{view.liveLabel}</p>
        <p>{view.deepLabel}</p>
      </div>
    </details>
  );
}
