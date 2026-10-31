import { packageManagerInvocation } from './lib/package-manager-invocation.mjs';
import { executedInvocations } from './lib/shell-invocation.mjs';
import { deny } from './native-effect-policy.mjs';
import { classifyNativeTarget } from './native-effect-target-classifier.mjs';

/** Preview grammar supplies attribution, not a second permission whitelist. */
export function protectedManagedPreviewBoundary(decisions, segments, cwd, source) {
  for (const [index, decision] of decisions.entries()) {
    const segment = segments[index];
    const selection = previewSelection(segment);
    const port = selection.port;
    if (!decision && !selection.claimed) continue;
    const literalTarget = classifyNativeTarget(segment, cwd, 'unknown');
    const target = port
      ? { kind: port === 6399 ? 'redis_sanctuary' : 'runtime_sanctuary', value: `tcp://127.0.0.1:${port}` }
      : (decision?.target ??
        (literalTarget.kind === 'ordinary' ? classifyNativeTarget(segment, cwd, 'process_control') : literalTarget));
    if (!['runtime_sanctuary', 'redis_sanctuary', 'protected_branch'].includes(target.kind)) continue;
    return {
      ...deny({ effect: 'process_control', target, source }, 'protected_managed_preview_operation'),
      ...(decision?.reason ? { detail: decision.reason } : {}),
    };
  }
  return null;
}

function previewSelection(segment) {
  let claimed = false;
  for (const call of executedInvocations(segment).pipelines.flat()) {
    if (packageManagerInvocation(call.name, call.operands).script !== 'preview:process') continue;
    claimed = true;
    const index = call.operands.indexOf('preview:process');
    if (index < 0) continue;
    const options = call.operands.slice(index + 2);
    for (const [offset, option] of options.entries()) {
      const value = ['--port', '--ports'].includes(option)
        ? options[offset + 1]
        : option.match(/^(?:--ports?=|[A-Z_]*PORT=)([\d,]+)$/)?.[1];
      const port = String(value)
        .split(',')
        .map(Number)
        .find((value) => [3001, 3002, 6399].includes(value));
      if (port) return { claimed, port };
    }
  }
  return { claimed };
}
