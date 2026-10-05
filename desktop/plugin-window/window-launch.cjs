function toPublishedWindowReply(reply, companionContract = '0.1.0-beta.21') {
  if (reply.kind !== 'state' || ['0.1.0-beta.23', '0.1.0-beta.24'].includes(companionContract)) return reply;
  const { behaviorEnabled: _nativePolicy, ...publicState } = reply;
  return publicState;
}

function validateLaunch(input) {
  const keys = input && Object.keys(input).sort().join(',');
  if (
    keys !== 'presentation,url' &&
    keys !== 'presentation,publicCompanionV2,url' &&
    keys !== 'companionContract,presentation,publicCompanionV2,url'
  )
    throw new Error('Invalid window request');
  if (input.publicCompanionV2 !== undefined && input.publicCompanionV2 !== true)
    throw new Error('Invalid public companion admission');
  if (
    input.companionContract !== undefined &&
    (input.publicCompanionV2 !== true ||
      !['0.1.0-beta.21', '0.1.0-beta.23', '0.1.0-beta.24'].includes(input.companionContract))
  )
    throw new Error('Invalid companion contract');
  const url = new URL(input.url);
  if (
    url.protocol !== 'http:' ||
    !/^companion-[a-f0-9]{32}\.localhost$/.test(url.hostname) ||
    !url.port ||
    !url.pathname.startsWith('/packages/') ||
    !url.pathname.endsWith('.html') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid surface');
  const p = input.presentation;
  if (
    !p ||
    Object.keys(p).sort().join(',') !== 'alwaysOnTop,frame,height,skipTaskbar,transparent,width' ||
    !Number.isInteger(p.width) ||
    p.width < 160 ||
    p.width > 600 ||
    !Number.isInteger(p.height) ||
    p.height < 160 ||
    p.height > 1000 ||
    p.frame !== false ||
    p.transparent !== true ||
    typeof p.alwaysOnTop !== 'boolean' ||
    typeof p.skipTaskbar !== 'boolean'
  )
    throw new Error('Invalid presentation');
  return {
    url: url.href,
    presentation: p,
    publicCompanionV2: input.publicCompanionV2 === true,
    ...(input.companionContract !== undefined ? { companionContract: input.companionContract } : {}),
  };
}

module.exports = { validateLaunch, toPublishedWindowReply };
