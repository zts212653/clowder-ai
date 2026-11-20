const { companionContractHas, isCompanionContract } = require('./companion-contracts.cjs');

function toPublishedWindowReply(reply, companionContract = '0.1.0-beta.21') {
  if (reply.kind !== 'state' || companionContractHas(companionContract, 'modern')) return reply;
  const { behaviorEnabled: _nativePolicy, ...publicState } = reply;
  return publicState;
}

/** A page of the Host's own static companion surface: loopback companion origin, package HTML only. */
function surfaceUrl(value) {
  const url = new URL(value);
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
  return url;
}
const directory = (url) => url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
/** F336: the verified living body page, only on a livingBody line and only beside the surface. */
function bodyPage(value, surface, contract) {
  const body = surfaceUrl(value);
  if (
    !companionContractHas(contract, 'livingBody') ||
    body.origin !== surface.origin ||
    directory(body) !== directory(surface) ||
    body.href === surface.href
  )
    throw new Error('Invalid body page');
  return body;
}

function validateLaunch(input) {
  const keys = input && Object.keys(input).sort().join(',');
  if (
    keys !== 'presentation,url' &&
    keys !== 'presentation,publicCompanionV2,url' &&
    keys !== 'companionContract,presentation,publicCompanionV2,url' &&
    keys !== 'bodyUrl,companionContract,presentation,publicCompanionV2,url'
  )
    throw new Error('Invalid window request');
  if (input.publicCompanionV2 !== undefined && input.publicCompanionV2 !== true)
    throw new Error('Invalid public companion admission');
  if (
    input.companionContract !== undefined &&
    (input.publicCompanionV2 !== true || !isCompanionContract(input.companionContract))
  )
    throw new Error('Invalid companion contract');
  const url = surfaceUrl(input.url);
  const body = input.bodyUrl === undefined ? undefined : bodyPage(input.bodyUrl, url, input.companionContract);
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
    ...(body ? { bodyUrl: body.href } : {}),
  };
}

/** The only external target the Host opens for a package: a local conversation link,
 * optionally pointing at one source message and one block. Never approves anything. */
function conversationTarget(params) {
  if (!params || Object.keys(params).join(',') !== 'url') throw new Error('Invalid conversation navigation');
  const target = new URL(params.url);
  const coordinate = /^[A-Za-z0-9_-]{1,200}$/;
  const validSource =
    !target.search ||
    (target.searchParams.getAll('message').length === 1 &&
      coordinate.test(target.searchParams.get('message')) &&
      target.searchParams.getAll('block').length <= 1 &&
      (!target.searchParams.has('block') || coordinate.test(target.searchParams.get('block'))) &&
      [...target.searchParams.keys()].every((key) => key === 'message' || key === 'block'));
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
    !/^\/thread\/[^/?#]+$/.test(target.pathname) ||
    target.username ||
    target.password ||
    !validSource ||
    target.hash
  )
    throw new Error('Invalid conversation navigation');
  return target.href;
}

module.exports = { validateLaunch, toPublishedWindowReply, conversationTarget };
