'use client';
import type { AssetCanonUpdate } from '@cat-cafe/shared';
import { type ComponentProps, useState } from 'react';
import { AssetCanonDetail } from './AssetCanonDetail';

export function AssetCanonPanel({
  updates,
  ...props
}: Omit<ComponentProps<typeof AssetCanonDetail>, 'update'> & { updates: AssetCanonUpdate[] }) {
  const [scope, setScope] = useState<string>();
  const update = updates.find((u) => u.noticeScope === scope) ?? updates[0];
  return (
    <>
      {updates.length > 1 ? (
        <div role="group" className="flex flex-wrap gap-2 px-3 pt-3" aria-label="这件素材的各项提示">
          {updates.map((u) => (
            <button
              key={`${u.noticeScope}:${u.updateFingerprint}`}
              type="button"
              aria-pressed={u === update}
              className="rounded border border-cafe-subtle px-2 py-1 text-xs"
              onClick={() => setScope(u.noticeScope)}
            >
              {u.noticeScope === 'file' ? '原件状态' : u.noticeScope === 'asset' ? '素材正典' : '用途绑定'}
            </button>
          ))}
        </div>
      ) : null}
      <AssetCanonDetail {...props} update={update} />
    </>
  );
}
