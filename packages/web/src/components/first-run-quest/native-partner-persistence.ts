import type { CatData } from '@/hooks/useCatData';
import { initialState, splitCommandArgs } from '../hub-cat-editor.model';
import { buildMemberPatchPayload } from '../hub-cat-editor.payload';
import { matchesRuntime } from '../settings/members/member-runtime-draft';
import { buildNativeCreationPayload } from './native-creation-payload';
import type { NativePartner } from './native-onboarding';

type ReadJson = <T>(path: string, init?: RequestInit) => Promise<T>;
interface SavedPartner {
  cat: { id: string; displayName: string; mentionPatterns: string[] };
  repairedCat?: CatData;
}
export const needsExistingDshRepair = (partner: NativePartner) =>
  Boolean(partner.existingId && partner.runtime.harnessId === 'dsh' && partner.runtime.dshSetupRequired);

/** Keep a prepared retry only while the exact revision it was confirmed against still exists. */
export function restoredDshPreparation(partner: NativePartner, previous: NativePartner) {
  return needsExistingDshRepair(partner) &&
    previous.dshSetupPrepared &&
    partner.dshSetupBaseline?.configurationRevision === previous.dshSetupBaseline?.configurationRevision
    ? { form: previous.form, dshSetupPrepared: true }
    : undefined;
}

function targetMatches(cat: CatData, partner: NativePartner) {
  return (
    cat.id === partner.existingId &&
    cat.clientId === 'acp' &&
    cat.carrier === 'acp' &&
    cat.configurationSource === 'native_tool' &&
    !cat.agentProvider &&
    !cat.acp?.agentProvider &&
    !cat.defaultModel &&
    !cat.cli?.effort &&
    matchesRuntime(initialState(cat), {
      ...partner.runtime,
      acp: {
        command: partner.form.acpCommand,
        startupArgs: splitCommandArgs(partner.form.acpStartupArgs),
        transport: partner.form.acpTransport,
      },
    })
  );
}

async function repairExistingDsh(
  partner: NativePartner,
  headers: Record<string, string>,
  readJson: ReadJson,
): Promise<SavedPartner> {
  const baseline = partner.dshSetupBaseline;
  if (
    !partner.dshSetupPrepared ||
    !baseline?.configurationRevision ||
    baseline.id !== partner.existingId ||
    partner.form.catId !== baseline.id ||
    partner.form.clientId !== 'acp' ||
    partner.form.carrier !== 'acp' ||
    partner.form.acpAgentProvider ||
    matchesRuntime(partner.form, partner.runtime)
  )
    throw Error('请重新检测并确认此 DSH 成员的可用供应商路由后保存。');
  const readMember = async () => {
    const roster = await readJson<{ cats: CatData[] }>('/api/cats');
    const cat = roster.cats.find((item) => item.id === baseline.id);
    if (!cat) throw Error('原 DSH 成员已不存在，请重新检测；不会自动创建重复成员。');
    return cat;
  };
  const current = await readMember();
  // A prior PATCH can commit before its response is lost. Never resend or replace its ID.
  if (targetMatches(current, partner)) return { cat: current, repairedCat: current };
  if (current.configurationRevision !== baseline.configurationRevision)
    throw Error('成员配置已发生变更，请重新检测并确认后保存；未覆盖其他修改。');
  const form = {
    ...initialState(baseline),
    acpCommand: partner.form.acpCommand,
    acpStartupArgs: partner.form.acpStartupArgs,
    acpTransport: partner.form.acpTransport,
    defaultModel: '',
    cliEffort: '',
  };
  const changed = buildMemberPatchPayload(form, baseline);
  const patch = Object.fromEntries(
    ['acp', 'defaultModel', 'cli'].filter((key) => key in changed).map((key) => [key, changed[key]]),
  );
  await readJson(`/api/cats/${encodeURIComponent(baseline.id)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ ...patch, expectedRevision: baseline.configurationRevision }),
  });
  const persisted = await readMember();
  if (!targetMatches(persisted, partner)) throw Error('成员保存后回读与确认配置不一致，请重新检测；未创建重复成员。');
  return { cat: persisted, repairedCat: persisted };
}

export async function saveNativePartner(
  partner: NativePartner,
  journeyId: string,
  headers: Record<string, string>,
  readJson: ReadJson,
): Promise<SavedPartner> {
  if (needsExistingDshRepair(partner)) return repairExistingDsh(partner, headers, readJson);
  if (partner.existingId)
    return {
      cat: {
        id: partner.existingId,
        displayName: partner.form.displayName,
        mentionPatterns: partner.form.mentionPatterns.split(/[\s,]+/).filter(Boolean),
      },
    };
  return readJson<SavedPartner>('/api/cats', {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': `onboarding:${journeyId}:cat:${partner.creationRequestKey ?? partner.id}`,
    },
    body: JSON.stringify(buildNativeCreationPayload(partner.form)),
  });
}

export function acknowledgeNativePartner(partner: NativePartner, result: SavedPartner): NativePartner {
  return result.repairedCat
    ? {
        ...partner,
        form: initialState(result.repairedCat),
        dshSetupPrepared: false,
        dshSetupBaseline: undefined,
        runtime: { ...partner.runtime, acp: result.repairedCat.acp, dshSetupRequired: false },
      }
    : { ...partner, form: { ...partner.form, catId: result.cat.id } };
}
