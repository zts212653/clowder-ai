export function inspectSecretValue<T>(
  value: T,
  options?: { knownCredentials?: readonly string[] },
): { value: T; rules: string[] };
