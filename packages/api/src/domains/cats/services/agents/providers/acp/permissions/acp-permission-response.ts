import type { AcpPermissionHandler } from '../AcpClient.js';
import type { AcpAgentRequest, AcpPermissionRequest, AcpResponse } from '../types.js';

export type AcpPermissionResult = { optionId: string } | { cancelled: true };

export function defaultAcpPermissionResult(
  request: AcpPermissionRequest,
  decision: 'allow' | 'reject' = 'allow',
): AcpPermissionResult {
  const option =
    decision === 'reject'
      ? (request.options?.find((option) => option.kind === 'reject_once') ??
        request.options?.find((option) => option.kind === 'reject_always') ??
        request.options?.find((option) => option.optionId === 'reject'))
      : (request.options?.find((option) => option.kind === 'allow_always') ??
        request.options?.find((option) => option.kind === 'allow_once'));
  return option ? { optionId: option.optionId } : { cancelled: true };
}

/** Both transports share one response fence and the same default decisions. */
export async function respondToAcpPermission(input: {
  request: AcpAgentRequest;
  handler?: AcpPermissionHandler;
  defaultDecision?: 'allow' | 'reject';
  signal?: AbortSignal;
  write(response: AcpResponse): void | Promise<void>;
}): Promise<void> {
  let responded = false;
  let writing: Promise<void> | undefined;
  const respond = (result: AcpPermissionResult) => {
    if (responded) return;
    responded = true;
    const outcome =
      'cancelled' in result
        ? { outcome: 'cancelled' as const }
        : { outcome: 'selected' as const, optionId: result.optionId };
    writing = Promise.resolve().then(() =>
      input.write({
        jsonrpc: '2.0',
        id: input.request.id,
        result: { outcome },
      }),
    );
  };
  try {
    if (input.handler) await input.handler(input.request, respond, { signal: input.signal });
    else
      respond(
        defaultAcpPermissionResult(input.request.params as unknown as AcpPermissionRequest, input.defaultDecision),
      );
  } catch (error) {
    if (!responded) {
      responded = true;
      writing = Promise.resolve().then(() =>
        input.write({
          jsonrpc: '2.0',
          id: input.request.id,
          error: {
            code: -32603,
            message: `Permission handler error: ${error instanceof Error ? error.message : String(error)}`,
          },
        }),
      );
    }
  }
  await writing;
}
