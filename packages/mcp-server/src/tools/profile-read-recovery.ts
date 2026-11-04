import type { ToolResult } from './file-tools.js';

/** Preserve an uncertain receipt; a confirmed profile conflict must start a new read. */
export function withProfileReadRecovery(result: ToolResult, requestId: string): ToolResult {
  if (!result.isError) return result;
  const first = result.content[0];
  const httpError =
    first?.type === 'text' ? /^Callback failed \((\d{3})\)(?: \[reason=[^\]]*\])?: ([\s\S]+)$/.exec(first.text) : null;
  const status = Number(httpError?.[1]);
  let code: unknown;
  if (httpError?.[2]) {
    try {
      const body: unknown = JSON.parse(httpError[2]);
      if (body && typeof body === 'object' && 'error' in body) code = body.error;
    } catch {
      // A non-JSON service failure leaves the receipt's outcome unknown.
    }
  }
  let advice: string;
  if (status === 409 && code === 'profile_read_request_changed') {
    advice =
      'This requestId is already bound to another profile or version. Start a new read with a new requestId (or omit it to generate one).';
  } else if (status === 409 && code === 'profile_revision_changed') {
    advice =
      'The expected profile revision changed. To read the current profile, start a new read without expectedRevision and with a new requestId (or omit requestId).';
  } else if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return result;
  } else {
    advice = `Retry this read with requestId: ${requestId}`;
  }
  return { ...result, content: [...result.content, { type: 'text', text: advice }] };
}
