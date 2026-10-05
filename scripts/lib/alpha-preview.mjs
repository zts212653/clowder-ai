import {
  assertNamedAlphaCheckout,
  assertNamedAlphaNotServing,
  deriveNamedAlphaCoordinates,
} from './alpha-coordinates.mjs';

function namedChildFlags(child) {
  const flags = child.slice(2);
  if (flags.length !== 4 && flags.length !== 5) return null;
  if (flags[0] !== '--instance' || flags[2] !== '--ports') return null;
  if (flags.length === 5 && flags[4] !== '--allow-empty-redis') return null;
  return flags;
}

/** A new Alpha child must be fully attributed or refused; unsupported shapes cannot fall back to ordinary. */
export function namedAlphaPreviewDecision(invocation, shellCwd) {
  const { action, child, options, packageCwd, separator } = invocation;
  if (!child.includes('alpha:start') || (child.length === 2 && child[0] === 'pnpm')) return null;
  const deny = { status: 'deny' };
  if (action !== 'start' || separator < 0 || child[0] !== 'pnpm' || child[1] !== 'alpha:start') return deny;
  if (options.has('--json')) return deny;
  const flags = namedChildFlags(child);
  if (!flags) return deny;
  const lifetime = options.get('--lifetime-seconds');
  if (lifetime !== undefined && (!/^[1-9]\d*$/.test(lifetime) || Number(lifetime) > 86400)) return deny;
  const requested = options.get('--cwd');
  if ((packageCwd ?? shellCwd) !== requested) return deny;
  try {
    const coordinates = deriveNamedAlphaCoordinates({ mainRoot: requested, instance: flags[1], ports: flags[3] });
    assertNamedAlphaCheckout(coordinates);
    assertNamedAlphaNotServing(coordinates);
    if (options.get('--port') !== String(coordinates.ports.frontend)) return deny;
    return {
      status: 'allow',
      operation: {
        kind: 'alpha',
        action,
        effect: 'service_mutation',
        target: `preview://alpha${coordinates.mainRoot}:${coordinates.ports.frontend}`,
      },
    };
  } catch {
    return deny;
  }
}
