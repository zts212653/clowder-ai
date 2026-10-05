/** Keep upstream HTTP failures distinct from connection failures. */
export async function audioHttpError(response: Response, operation: string): Promise<string> {
  const body = await response.text();
  let reason = body;
  try {
    const error = JSON.parse(body) as { message?: unknown; error?: unknown };
    if (typeof error.message === 'string') reason = error.message;
    else if (typeof error.error === 'string') reason = error.error;
  } catch {
    // Some gateways return plain text, and some JSON bodies are null.
  }
  return `${operation} failed: ${response.status}${reason ? `: ${reason.slice(0, 500)}` : ''}`;
}
