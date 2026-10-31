import { type CopyTree, type ShellCopy, useShellCopy } from '@/components/shell/shell-copy';
import { useShellPresentation } from '@/components/shell/shell-presentation';

// Locale follows the live shell choice. Classic keeps its existing wording.
export function useTrajectoryCopy<T extends CopyTree>(copy: ShellCopy<T>): T {
  const selected = useShellCopy(copy);
  return useShellPresentation() === 'v2' ? selected : copy.zh;
}
