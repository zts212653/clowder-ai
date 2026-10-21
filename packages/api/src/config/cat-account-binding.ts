import type { CatConfig } from '@cat-cafe/shared';

function trimBinding(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A native member without an explicit account delegates provider/auth selection to its CLI. */
export function usesNativeToolConfiguration(
  catConfig: Pick<CatConfig, 'configurationSource' | 'accountRef'> | null | undefined,
): boolean {
  return catConfig?.configurationSource === 'native_tool' && !trimBinding(catConfig.accountRef);
}

/**
 * Resolve the bound accountRef for runtime and editor flows.
 *
 * accountRef is authoritative once it has been written into the runtime
 * catalog. Bootstrap/template state must not reinterpret it later.
 */
export function resolveBoundAccountRefForCat(
  _projectRoot: string,
  _catId: string,
  catConfig: CatConfig | null | undefined,
): string | undefined {
  if (!catConfig) return undefined;
  return trimBinding(catConfig.accountRef);
}
