export function buildProbeHeaders(
  protocol: 'anthropic' | 'openai' | 'openai-responses' | 'google',
  apiKey: string,
): Record<string, string> {
  switch (protocol) {
    case 'anthropic':
      return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    case 'google':
      return { 'x-goog-api-key': apiKey };
    case 'openai':
    case 'openai-responses':
    default:
      return { authorization: `Bearer ${apiKey}` };
  }
}

export async function readProbeError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return text.slice(0, 400);
}

export function isInvalidModelProbeError(errorText: string): boolean {
  return /(invalid model|model[^a-z0-9]*(not found|does not exist|unsupported))/i.test(errorText);
}
