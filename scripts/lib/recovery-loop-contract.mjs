import { discoverRecoveryLoopSites } from './recovery-loop-sites.mjs';

function inspectRegistration(registration, findings) {
  if (!registration.reason?.trim()) findings.push({ code: 'missing-reason', id: registration.id });
  if (!['pending', 'indexed', 'exempt'].includes(registration.state))
    findings.push({ code: 'invalid-state', id: registration.id });
  if (registration.state === 'indexed' && !registration.storeAudit)
    findings.push({ code: 'missing-store-audit', id: registration.id });
}

function inspectSites(sites, registered, discovered, findings) {
  for (const site of sites) {
    if (registered.has(site)) findings.push({ code: 'duplicate-site', site });
    registered.add(site);
    if (!discovered.has(site)) findings.push({ code: 'stale-registration', site });
  }
}

/** Registration classifies scheduling sites; lifecycle and recovery facts stay with each owner. */
export function inspectRecoveryLoops(sources, registrations) {
  const sites = [...sources].flatMap(([file, text]) => discoverRecoveryLoopSites(file, text));
  const discovered = new Set(sites.map((site) => site.key));
  const registered = new Set();
  const ids = new Set();
  const findings = [];
  const pending = [];
  for (const registration of registrations) {
    if (ids.has(registration.id)) findings.push({ code: 'duplicate-id', id: registration.id });
    ids.add(registration.id);
    inspectRegistration(registration, findings);
    if (registration.state === 'pending') pending.push(registration.id);
    inspectSites(registration.sites, registered, discovered, findings);
  }
  for (const site of sites) if (!registered.has(site.key)) findings.push({ code: 'unregistered', site: site.key });
  return { sites, findings, pending };
}
