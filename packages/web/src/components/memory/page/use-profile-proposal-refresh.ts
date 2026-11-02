import { useEffect, useRef } from 'react';

/** Approval is owned by the original card. Refresh its projection without discarding an owner draft. */
export function useProfileProposalRefresh(
  ids: string,
  editing: boolean,
  refreshDetail: () => void,
  refreshList: () => void,
) {
  const deferred = useRef(false);
  useEffect(() => {
    const refresh = () => {
      refreshDetail();
      refreshList();
    };
    if (!editing && deferred.current) {
      deferred.current = false;
      refresh();
    }
    const onUpdated = (event: Event) => {
      const id = (event as CustomEvent<{ proposalId?: string }>).detail?.proposalId;
      if (!id || !ids.split(',').includes(id)) return;
      if (editing) deferred.current = true;
      else refresh();
    };
    window.addEventListener('cat-cafe:proposal-updated', onUpdated);
    return () => window.removeEventListener('cat-cafe:proposal-updated', onUpdated);
  }, [ids, editing, refreshDetail, refreshList]);
}
