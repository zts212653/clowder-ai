import { describe, expect, it } from 'vitest';
import { servedFactsFromUsagePayload } from '../served-model-facts';

describe('F319 Phase E.1 servedFactsFromUsagePayload', () => {
  it('keeps every well-typed served fact', () => {
    expect(
      servedFactsFromUsagePayload({
        served: {
          servedModel: 'gpt-5.6-sol',
          servedResponseId: 'resp_1',
          servedModelSource: 'ws_response_object',
          upstreamTurnStateLength: 312,
          upstreamSafetyBufferingFasterModel: 'gpt-5.6-luna',
          upstreamSafetyBuffering: false,
        },
      }),
    ).toEqual({
      servedModel: 'gpt-5.6-sol',
      servedResponseId: 'resp_1',
      servedModelSource: 'ws_response_object',
      upstreamTurnStateLength: 312,
      upstreamSafetyBufferingFasterModel: 'gpt-5.6-luna',
      upstreamSafetyBuffering: false,
    });
  });

  it('no served key, or no servedModel, is unobserved: returns undefined, never an empty default', () => {
    expect(servedFactsFromUsagePayload({})).toBeUndefined();
    expect(servedFactsFromUsagePayload({ served: null })).toBeUndefined();
    expect(servedFactsFromUsagePayload({ served: { upstreamTurnStateLength: 312 } })).toBeUndefined();
    expect(servedFactsFromUsagePayload({ served: { servedModel: '   ' } })).toBeUndefined();
  });

  it('drops mistyped fields instead of coercing them', () => {
    expect(
      servedFactsFromUsagePayload({
        served: {
          servedModel: 'gpt-5.6-sol',
          servedModelSource: 'carrier_pigeon',
          upstreamTurnStateLength: '312',
          upstreamSafetyBuffering: 'false',
          servedResponseId: 7,
        },
      }),
    ).toEqual({ servedModel: 'gpt-5.6-sol' });
    expect(servedFactsFromUsagePayload({ served: { servedModel: 'x', upstreamTurnStateLength: Number.NaN } })).toEqual({
      servedModel: 'x',
    });
  });
});
