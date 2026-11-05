import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { freezeExecutionAccountBinding } from '../dist/domains/cats/services/agents/invocation/execution-account-binding.js';

const member = {
  id: 'profile-test',
  name: '伙伴',
  displayName: '审查伙伴',
  nickname: '同伴',
  avatar: '/test.png',
  color: { primary: '#123456', secondary: '#abcdef' },
  mentionPatterns: ['@profile-test'],
  roleDescription: '审查当前任务',
  personality: '谨慎',
  relationshipKey: 'stable-relationship',
  clientId: 'acp',
  carrier: 'acp',
  configurationSource: 'native_tool',
  defaultModel: '',
  mcpSupport: true,
  cli: { command: 'test-agent', effort: 'medium' },
};

describe('member identity and execution projections at admission', () => {
  it('separates role identity from client and model without changing the stored member', () => {
    const original = structuredClone(member);
    const binding = freezeExecutionAccountBinding({
      catId: member.id,
      catConfig: member,
      workspace: { usesDefaultWorkspace: false },
    });
    assert.equal(binding.roleProfile?.id, member.id);
    assert.equal(binding.roleProfile?.roleDescription, member.roleDescription);
    assert.match(binding.personaDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal('clientId' in binding.roleProfile, false);
    assert.equal('defaultModel' in binding.roleProfile, false);
    assert.equal(binding.executionProfile?.clientId, 'acp');
    assert.deepEqual(binding.executionPreferences, {
      configurationSource: 'native_tool',
      model: '',
      effort: 'medium',
      nativeAuthentication: true,
    });
    assert.equal('personality' in binding.executionProfile, false);
    assert.deepEqual(member, original);
  });

  it('pins the projected role and execution values against later input edits', () => {
    const mutable = structuredClone(member);
    const binding = freezeExecutionAccountBinding({
      catId: mutable.id,
      catConfig: mutable,
      workspace: { usesDefaultWorkspace: false },
    });
    mutable.roleDescription = '另一份职责';
    mutable.cli.effort = 'high';
    assert.equal(binding.roleProfile?.roleDescription, '审查当前任务');
    assert.equal(binding.executionProfile?.cli.effort, 'medium');
    assert.equal(binding.executionPreferences.effort, 'medium');
    assert.ok(Object.isFrozen(binding.roleProfile));
    assert.ok(Object.isFrozen(binding.executionProfile));
  });

  it('keeps presentation-only edits out of the pure persona digest', () => {
    const first = freezeExecutionAccountBinding({
      catId: member.id,
      catConfig: member,
      workspace: { usesDefaultWorkspace: false },
    });
    const second = freezeExecutionAccountBinding({
      catId: member.id,
      catConfig: { ...member, avatar: '/new.png', color: { primary: '#fff', secondary: '#000' } },
      workspace: { usesDefaultWorkspace: false },
    });
    assert.equal(second.personaDigest, first.personaDigest);
  });
});
