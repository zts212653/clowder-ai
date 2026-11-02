import type { RuntimeInteractionOwner } from '@cat-cafe/shared';
import { z } from 'zod';
import type { RuntimeInteractionPort } from '../../../../../runtime-interaction/ports/RuntimeInteractionPort.js';
import { RuntimeInteractionError } from '../../../../../runtime-interaction/RuntimeInteractionError.js';
import type { AcpPermissionHandler } from './AcpClient.js';
import { type AcpPermissionResult, defaultAcpPermissionResult } from './acp-permission-response.js';
import { ACP_METHODS } from './types.js';

const permissionSchema = z.object({
  sessionId: z.string().min(1),
  options: z
    .array(
      z.object({
        optionId: z.string().min(1),
        name: z.string().min(1),
        kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
      }),
    )
    .min(1),
  toolCall: z.object({ title: z.string().optional(), rawInput: z.unknown().optional() }).optional(),
});
const cancelledReasons = new Set([
  'user_rejected',
  'user_cancelled',
  'provider_cancelled',
  'withdrawn',
  'superseded',
  'expired',
]);

/** Member policy adds human confirmation after existing native restrictions, never instead of them. */
export function createAcpPermissionHandler(context: {
  mode: 'auto' | 'ask_user';
  sessionId: string;
  defaultDecision?: 'allow' | 'reject';
  guard?: AcpPermissionHandler;
  owner?: RuntimeInteractionOwner;
  port?: Pick<RuntimeInteractionPort, 'request'>;
  signal?: AbortSignal;
  isActive(): boolean;
}): AcpPermissionHandler {
  return async (request, respond, transport) => {
    const signal =
      context.signal && transport?.signal
        ? AbortSignal.any([context.signal, transport.signal])
        : (transport?.signal ?? context.signal);
    const params = permissionSchema.parse(request.params);
    if (params.sessionId !== context.sessionId || !context.isActive() || signal?.aborted) {
      respond({ cancelled: true });
      return;
    }
    let decision: AcpPermissionResult | undefined;
    if (context.defaultDecision === 'reject') decision = defaultAcpPermissionResult(params, 'reject');
    else if (context.guard)
      await context.guard(request, (result) => {
        decision = result;
      });
    else decision = defaultAcpPermissionResult(params, context.defaultDecision);
    const choice = decision;
    const selected =
      choice && 'optionId' in choice ? params.options.find((option) => option.optionId === choice.optionId) : undefined;
    if (!selected || selected.kind.startsWith('reject') || context.mode === 'auto') {
      respond(decision ?? { cancelled: true });
      return;
    }
    // A human may decline or cancel, but cannot broaden a native guard's grant.
    const offered = params.options.flatMap((option, index) =>
      context.guard && option.kind.startsWith('allow') && option.optionId !== selected.optionId
        ? []
        : [{ ...option, decisionId: `option-${index}` }],
    );
    if (!context.port || !context.owner) throw new Error('ACP user confirmation is unavailable for this invocation');
    const response = await context.port
      .request(
        {
          version: 1,
          interactionId: crypto.randomUUID(),
          kind: 'approval',
          owner: context.owner,
          provider: {
            providerId: 'acp',
            method: ACP_METHODS.requestPermission,
            requestId: request.id,
            threadId: context.sessionId,
          },
          createdAt: Date.now(),
          title: params.toolCall?.title?.trim() || 'ACP 客户端请求执行权限',
          ...(params.toolCall?.rawInput === undefined
            ? {}
            : { description: JSON.stringify(params.toolCall.rawInput, null, 2).slice(0, 8192) }),
          decisions: [
            ...offered.map((option) => ({
              id: option.decisionId,
              label: option.name,
              outcome: option.kind.startsWith('allow') ? ('accept' as const) : ('decline' as const),
            })),
            { id: 'cancel', label: '取消', outcome: 'cancel' },
          ],
        },
        { signal },
      )
      .catch((error: unknown) => {
        if (error instanceof RuntimeInteractionError && error.reasonCode && cancelledReasons.has(error.reasonCode))
          return undefined;
        throw error;
      });
    const option =
      response?.kind === 'decision' ? offered.find((option) => response.decisionId === option.decisionId) : undefined;
    respond(option && context.isActive() && !signal?.aborted ? { optionId: option.optionId } : { cancelled: true });
  };
}
