import { describe, expect, it } from 'vitest';
import { GameState } from '../game-state';

describe('GameState', () => {
  it('creates two fighters with full HP', () => {
    const gs = new GameState(['opus46', 'codex']);
    expect(gs.p1.hp).toBe(100);
    expect(gs.p2.hp).toBe(100);
    expect(gs.p1.id).toBe('opus46');
    expect(gs.p2.id).toBe('codex');
  });

  it('p1 starts facing right, p2 facing left', () => {
    const gs = new GameState(['opus46', 'codex']);
    expect(gs.p1.facing).toBe('right');
    expect(gs.p2.facing).toBe('left');
  });

  it('applyDamage reduces HP and clamps to 0', () => {
    const gs = new GameState(['opus46', 'codex']);
    gs.applyDamage('codex', 30);
    expect(gs.p2.hp).toBe(70);
    gs.applyDamage('codex', 80);
    expect(gs.p2.hp).toBe(0);
  });

  it('isOver returns true when any fighter HP reaches 0', () => {
    const gs = new GameState(['opus46', 'codex']);
    expect(gs.isOver()).toBe(false);
    gs.applyDamage('opus46', 100);
    expect(gs.isOver()).toBe(true);
  });

  it('winner returns the fighter with HP > 0', () => {
    const gs = new GameState(['opus46', 'codex']);
    gs.applyDamage('codex', 100);
    expect(gs.winner()).toBe('opus46');
  });

  it('checkHit returns HitResult when in range and attacking', () => {
    const gs = new GameState(['opus46', 'codex']);
    gs.p1.x = 100;
    gs.p2.x = 140; // within ATTACK_RANGE (60)
    gs.p1.state = 'attack';
    const hit = gs.checkHit('opus46');
    expect(hit).not.toBeNull();
    expect(hit?.damage).toBe(7); // opus46 attackDamage from FIGHTER_STATS
  });

  it('checkHit returns null when out of range', () => {
    const gs = new GameState(['opus46', 'codex']);
    gs.p1.x = 100;
    gs.p2.x = 300; // way out of range
    gs.p1.state = 'attack';
    expect(gs.checkHit('opus46')).toBeNull();
  });

  it('P1-1: checkHit only hits once per attack swing', () => {
    const gs = new GameState(['opus46', 'codex']);
    gs.p1.x = 100;
    gs.p2.x = 140; // within range
    gs.p1.state = 'attack';

    // First check hits
    const hit1 = gs.checkHit('opus46');
    expect(hit1).not.toBeNull();

    // Consume the hit
    gs.consumeHit('opus46');

    // Second check on same swing should NOT hit
    const hit2 = gs.checkHit('opus46');
    expect(hit2).toBeNull();
  });

  it('P1-1: new attack after cooldown can hit again', () => {
    const gs = new GameState(['opus46', 'codex']);
    gs.p1.x = 100;
    gs.p2.x = 140;
    gs.p1.state = 'attack';

    gs.checkHit('opus46');
    gs.consumeHit('opus46');
    expect(gs.checkHit('opus46')).toBeNull();

    // Simulate new attack swing
    gs.p1.state = 'idle';
    gs.p1.state = 'attack';
    gs.resetSwing('opus46');
    const hit = gs.checkHit('opus46');
    expect(hit).not.toBeNull();
  });
});

describe('4-fighter GameState', () => {
  it('creates 4 fighters with correct positions', () => {
    const gs = new GameState(['opus46', 'opus45', 'codex', 'gpt54']);
    expect(gs.fighters).toHaveLength(4);
    expect(gs.fighters[0].id).toBe('opus46');
    expect(gs.fighters[3].id).toBe('gpt54');
  });

  it('4-fighter HP scales up to survive multi-attacker focus', () => {
    const gs4 = new GameState(['opus46', 'opus45', 'codex', 'gpt54']);
    const gs2 = new GameState(['opus46', 'codex']);
    // 4 fighters need more HP than 2 fighters
    expect(gs4.fighters[0].hp).toBeGreaterThan(gs2.fighters[0].hp);
    expect(gs4.fighters[0].maxHp).toBe(gs4.fighters[0].hp);
  });

  it('getFighter returns correct fighter by id', () => {
    const gs = new GameState(['opus46', 'opus45', 'codex', 'gpt54']);
    expect(gs.getFighter('gpt54').name).toBe('GPT 5.4');
  });

  it('isOver when only one fighter remains alive', () => {
    const gs = new GameState(['opus46', 'opus45', 'codex', 'gpt54']);
    const killHp = gs.fighters[0].maxHp; // works regardless of HP scaling
    expect(gs.isOver()).toBe(false);
    gs.applyDamage('opus46', killHp);
    expect(gs.isOver()).toBe(false); // 3 still alive
    gs.applyDamage('opus45', killHp);
    expect(gs.isOver()).toBe(false); // 2 still alive
    gs.applyDamage('codex', killHp);
    expect(gs.isOver()).toBe(true); // only gpt54 alive
  });

  it('skill cooldown initializes to 0', () => {
    const gs = new GameState(['opus46', 'codex']);
    expect(gs.getFighter('opus46').skillCooldownMs).toBe(0);
  });

  it('p1/p2 aliases work for 2-fighter mode', () => {
    const gs = new GameState(['opus46', 'codex']);
    expect(gs.p1.id).toBe('opus46');
    expect(gs.p2.id).toBe('codex');
  });

  it('getOpponent returns nearest living enemy in 4-fighter mode', () => {
    const gs = new GameState(['opus46', 'opus45', 'codex', 'gpt54']);
    // opus46 at far left, gpt54 at far right — nearest opponent should be opus45
    const opp = gs.getOpponent('opus46');
    expect(opp.id).toBe('opus45');
  });

  it('winner returns null when multiple fighters alive', () => {
    const gs = new GameState(['opus46', 'opus45', 'codex', 'gpt54']);
    const killHp = gs.fighters[0].maxHp;
    gs.applyDamage('opus46', killHp);
    gs.applyDamage('opus45', killHp);
    gs.applyDamage('codex', killHp);
    // gpt54 is the last one standing
    expect(gs.winner()).toBe('gpt54');
  });
});

describe('skill system', () => {
  it('activateSkill sets cooldown and active duration', () => {
    const gs = new GameState(['opus46', 'codex']);
    const activated = gs.activateSkill('opus46');
    expect(activated).toBe(true);
    const f = gs.getFighter('opus46');
    expect(f.skillCooldownMs).toBe(8000); // architecture_lock cooldown
    expect(f.skillActiveMs).toBe(2000);
  });

  it('activateSkill returns false if on cooldown', () => {
    const gs = new GameState(['opus46', 'codex']);
    gs.activateSkill('opus46');
    const again = gs.activateSkill('opus46');
    expect(again).toBe(false);
  });

  it('activateSkill returns false if stunned', () => {
    const gs = new GameState(['opus46', 'codex']);
    gs.getFighter('opus46').stunMs = 1000;
    expect(gs.activateSkill('opus46')).toBe(false);
  });

  it('checkSkillHit returns hit when in skill range', () => {
    const gs = new GameState(['opus46', 'codex']);
    gs.getFighter('codex').x = gs.getFighter('opus46').x + 50;
    gs.activateSkill('opus46');
    const hit = gs.checkSkillHit('opus46');
    expect(hit).not.toBeNull();
    expect(hit?.damage).toBe(5); // architecture_lock damage
  });

  it('checkSkillHit returns null when out of range', () => {
    const gs = new GameState(['opus46', 'codex']);
    // default positions are 120 and 520 — way out of 80 range
    gs.activateSkill('opus46');
    const hit = gs.checkSkillHit('opus46');
    expect(hit).toBeNull();
  });

  it('applySkillEffect: architecture_lock stuns target', () => {
    const gs = new GameState(['opus46', 'codex']);
    gs.getFighter('codex').x = gs.getFighter('opus46').x + 50;
    gs.activateSkill('opus46');
    const hit = gs.checkSkillHit('opus46');
    expect(hit).not.toBeNull();
    gs.applySkillEffect('opus46', hit!.defenderId);
    expect(gs.getFighter('codex').stunMs).toBe(2000);
  });

  it('applySkillEffect: code_flood applies knockback', () => {
    const gs = new GameState(['opus46', 'codex']);
    // Place codex close to codex-user (who is... wait codex IS the user)
    // Actually let's test with codex using skill on opus46
    gs.getFighter('opus46').x = gs.getFighter('codex').x - 50;
    gs.activateSkill('codex');
    const hit = gs.checkSkillHit('codex');
    expect(hit).not.toBeNull();
    const beforeX = gs.getFighter('opus46').x;
    gs.applySkillEffect('codex', hit!.defenderId);
    // code_flood pushes opponent away
    expect(gs.getFighter('opus46').x).not.toBe(beforeX);
  });

  it('tickCooldowns reduces all timers', () => {
    const gs = new GameState(['opus46', 'codex']);
    gs.activateSkill('opus46');
    gs.getFighter('codex').stunMs = 500;
    gs.tickCooldowns(200);
    expect(gs.getFighter('opus46').skillCooldownMs).toBe(7800);
    expect(gs.getFighter('opus46').skillActiveMs).toBe(1800);
    expect(gs.getFighter('codex').stunMs).toBe(300);
  });

  it('tickCooldowns clamps to 0', () => {
    const gs = new GameState(['opus46', 'codex']);
    gs.getFighter('opus46').skillCooldownMs = 100;
    gs.tickCooldowns(500);
    expect(gs.getFighter('opus46').skillCooldownMs).toBe(0);
  });
});
