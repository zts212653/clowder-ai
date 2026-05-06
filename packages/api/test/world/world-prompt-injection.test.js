import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildInvocationContext } from '../../dist/domains/cats/services/context/SystemPromptBuilder.js';

describe('F093 world context prompt injection', () => {
  const baseContext = {
    catId: 'opus',
    mode: 'independent',
    teammates: [],
    mcpAvailable: false,
  };

  it('injects world/scene/character when worldContext is present', () => {
    const result = buildInvocationContext({
      ...baseContext,
      worldContext: {
        world: {
          worldId: 'w1',
          name: '逐峰宇宙',
          status: 'active',
          constitution: '时间是线性的',
          createdBy: { kind: 'user', id: 'you' },
          createdAt: '2026-04-30T12:00:00Z',
        },
        scene: {
          sceneId: 's1',
          worldId: 'w1',
          name: '第一幕',
          mode: 'build',
          status: 'active',
          activeCharacterIds: ['ch1'],
          createdAt: '2026-04-30T12:00:00Z',
          updatedAt: '2026-04-30T12:00:00Z',
        },
        characters: [
          {
            characterId: 'ch1',
            worldId: 'w1',
            coreIdentity: { name: 'A.W.', role: 'protagonist' },
            innerDrive: { motivation: '寻找真相' },
            updatedAt: '2026-04-30T12:00:00Z',
          },
        ],
        recentEvents: [],
        relationshipSnapshot: [],
        canonSummary: [{ recordId: 'c1', summary: '时间穿越被禁止', acceptedAt: '2026-04-30T12:00:00Z' }],
        recall: { canonMatches: [], eventMatches: [] },
      },
    });
    assert.ok(result.includes('逐峰宇宙'), 'should contain world name');
    assert.ok(result.includes('第一幕'), 'should contain scene name');
    assert.ok(result.includes('A.W.'), 'should contain character name');
    assert.ok(result.includes('寻找真相'), 'should contain motivation');
    assert.ok(result.includes('时间穿越被禁止'), 'should contain canon');
    assert.ok(result.includes('时间是线性的'), 'should contain constitution');
  });

  it('omits world section when worldContext is absent', () => {
    const result = buildInvocationContext(baseContext);
    assert.ok(!result.includes('🌍 World:'), 'should not contain world section');
  });

  it('includes careLoopHint when present', () => {
    const result = buildInvocationContext({
      ...baseContext,
      worldContext: {
        world: {
          worldId: 'w1',
          name: 'test',
          status: 'active',
          createdBy: { kind: 'user', id: 'u' },
          createdAt: '2026-04-30T12:00:00Z',
        },
        scene: {
          sceneId: 's1',
          worldId: 'w1',
          name: 'scene',
          mode: 'build',
          status: 'active',
          activeCharacterIds: [],
          createdAt: '2026-04-30T12:00:00Z',
          updatedAt: '2026-04-30T12:00:00Z',
        },
        characters: [],
        recentEvents: [],
        relationshipSnapshot: [],
        canonSummary: [],
        recall: { canonMatches: [], eventMatches: [] },
        careLoopHint: {
          trigger: '角色低落',
          suggestion: '关心铲屎官',
          realityBridge: '你今天怎么样？',
        },
      },
    });
    assert.ok(result.includes('角色低落'), 'should contain care trigger');
    assert.ok(result.includes('关心铲屎官'), 'should contain care suggestion');
  });
});
