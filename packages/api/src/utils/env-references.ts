/** Expand ordinary ${NAME} environment references without changing destination keys. */
export function resolveEnvReferences(
  values: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value.replace(/\$\{([^}]+)\}/g, (_reference, name: string) => environment[name] ?? ''),
    ]),
  );
}
