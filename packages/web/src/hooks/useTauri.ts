import { useEffect, useState } from 'react';

/** Detect if the app is running inside a Tauri desktop shell */
export function useTauri(): boolean {
  const [isTauri, setIsTauri] = useState(false);

  useEffect(() => {
    // Tauri v2 injects __TAURI_INTERNALS__ on the window object
    setIsTauri('__TAURI_INTERNALS__' in window);
  }, []);

  return isTauri;
}
