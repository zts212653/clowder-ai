'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type AssetCollaborationAction,
  type AssetCollaborationState,
  createInitialAssetCollaborationState,
  persistAssetCollaborationState,
  readAssetCollaborationState,
  reduceAssetCollaboration,
} from './asset-collaboration-store';

export type PersistenceStatus = 'saved' | 'unavailable';

interface AssetCollaborationStoreOptions {
  initialState?: AssetCollaborationState;
  storageKey?: string;
}

export function useAssetCollaborationStore(options: AssetCollaborationStoreOptions = {}): {
  state: AssetCollaborationState;
  dispatch: (action: AssetCollaborationAction) => void;
  persistenceStatus: PersistenceStatus;
} {
  const { initialState, storageKey } = options;
  const [state, setState] = useState(() => initialState ?? createInitialAssetCollaborationState());
  const [persistenceStatus, setPersistenceStatus] = useState<PersistenceStatus>('saved');
  const stateRef = useRef(state);

  useEffect(() => {
    const restored = readAssetCollaborationState(window.localStorage, storageKey);
    if (!restored) return;
    stateRef.current = restored;
    setState(restored);
    setPersistenceStatus(
      persistAssetCollaborationState(restored, window.localStorage, storageKey) ? 'saved' : 'unavailable',
    );
  }, [storageKey]);

  const dispatch = useCallback(
    (action: AssetCollaborationAction) => {
      const next = reduceAssetCollaboration(stateRef.current, action);
      if (next === stateRef.current) return;
      stateRef.current = next;
      setState(next);
      setPersistenceStatus(
        persistAssetCollaborationState(next, window.localStorage, storageKey) ? 'saved' : 'unavailable',
      );
    },
    [storageKey],
  );

  return { state, dispatch, persistenceStatus };
}
