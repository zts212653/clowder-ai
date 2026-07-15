/**
 * F113 drive-picker hook: tracks whether we're showing the drives grid vs a
 * directory listing, and lazily loads the Windows drive list on first entry.
 *
 * State machine (R3 review P1#2): explicit `idle | loading | ready | error`
 * instead of a single drivesLoadedRef flag. The old flag was set before the
 * request resolved, so one transient failure permanently disabled retry until
 * remount. The state machine allows retry from the error state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface DriveInfo {
  letter: string;
  path: string;
  label: string;
}

export type DrivesState = 'idle' | 'loading' | 'ready' | 'error';

export interface UseDrivesLoaderResult {
  view: 'directory' | 'drives';
  drives: DriveInfo[];
  drivesState: DrivesState;
  /** True when the server filesystem is Windows (drives concept applies). */
  showThisPcEntry: boolean;
  showDrivesView: () => void;
  showDirectoryView: () => void;
  /** Retry loading drives after an error. */
  retryLoadDrives: () => void;
}

/**
 * @param isWindowsServer - whether the API server's filesystem is Windows
 *   (derived from server-owned capability, not client UA).
 */
export function useDrivesLoader(isWindowsServer: boolean): UseDrivesLoaderResult {
  const [view, setView] = useState<'directory' | 'drives'>('directory');
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [drivesState, setDrivesState] = useState<DrivesState>('idle');
  const fetchInFlightRef = useRef(false);

  const loadDrives = useCallback(async () => {
    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;
    setDrivesState('loading');
    try {
      const res = await apiFetch('/api/projects/drives');
      if (!res.ok) {
        setDrivesState('error');
        return;
      }
      const data = await res.json();
      setDrives(Array.isArray(data.drives) ? data.drives : []);
      setDrivesState('ready');
    } catch {
      setDrivesState('error');
    } finally {
      fetchInFlightRef.current = false;
    }
  }, []);

  // Lazily fetch drives only when the user enters the drives view - keeps
  // mount-time API calls unchanged for the common directory-browsing path.
  useEffect(() => {
    if (view !== 'drives') return;
    if (drivesState === 'idle') {
      loadDrives();
    }
  }, [view, drivesState, loadDrives]);

  const showDrivesView = useCallback(() => setView('drives'), []);
  const showDirectoryView = useCallback(() => setView('directory'), []);
  const retryLoadDrives = useCallback(() => {
    setDrivesState('idle');
  }, []);

  return {
    view,
    drives,
    drivesState,
    showThisPcEntry: isWindowsServer,
    showDrivesView,
    showDirectoryView,
    retryLoadDrives,
  };
}
