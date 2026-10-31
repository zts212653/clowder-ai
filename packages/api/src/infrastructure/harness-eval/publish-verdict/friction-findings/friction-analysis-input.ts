import {
  type FrictionAnalysisFindingInputV1,
  parseFrictionAnalysisFindingInputs,
} from '../../friction/friction-finding-artifact.js';
import type { VerdictHandoffPacket } from '../../verdict-handoff.js';
import type { HandlerError, PublishVerdictInput } from '../types.js';

export function rejectServerOwnedFrictionPacketFields(packet: unknown): HandlerError | undefined {
  if (!packet || typeof packet !== 'object') return undefined;
  if (!('repairTarget' in packet) && !('findingBinding' in packet)) return undefined;
  return {
    status: 400,
    error: 'server_owned_packet_fields',
    detail: 'repairTarget and findingBinding are server-owned child fields; submit analysisFindings target hints only',
  };
}

export function validateFrictionAnalysisInput(
  domainId: string,
  input: PublishVerdictInput['analysisFindings'],
): { findings?: readonly FrictionAnalysisFindingInputV1[]; error?: HandlerError } {
  if (input === undefined) return {};
  if (domainId !== 'eval:friction') {
    return {
      error: {
        status: 400,
        error: 'analysis_findings_wrong_domain',
        detail: 'analysisFindings is accepted only for eval:friction publishes',
      },
    };
  }
  try {
    return { findings: parseFrictionAnalysisFindingInputs(input) };
  } catch (error) {
    return {
      error: {
        status: 400,
        error: 'invalid_analysis_findings',
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function validateFrictionAggregateWrite(
  packet: VerdictHandoffPacket,
  findings?: readonly FrictionAnalysisFindingInputV1[],
): HandlerError | undefined {
  if (findings && packet.verdict !== 'keep_observe') {
    return {
      status: 400,
      error: 'invalid_analysis_findings',
      detail:
        'finding breakout requires a keep_observe aggregate verdict; actionable authority lives only on child roots',
    };
  }
  if (packet.domainId !== 'eval:friction' || (!packet.findingKey && packet.verdict === 'keep_observe')) {
    return undefined;
  }
  return {
    status: 400,
    error: 'invalid_friction_aggregate',
    detail:
      'new eval:friction publishes must be non-actionable aggregates without findingKey; case identity and actionable authority live only on server-generated child roots',
  };
}
