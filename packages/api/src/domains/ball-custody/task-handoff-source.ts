/** A Task request must enter through Task admission, including malformed persisted requests. */
export function isTaskHandoffSource(
  source: { extra?: { taskHandoff?: unknown; taskHandoffInvalid?: unknown } } | null | undefined,
): boolean {
  return Boolean(source?.extra?.taskHandoff || source?.extra?.taskHandoffInvalid);
}
