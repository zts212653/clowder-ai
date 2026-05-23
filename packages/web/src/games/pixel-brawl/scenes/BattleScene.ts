import * as Phaser from 'phaser';
import { type AiAction, AiController } from '../ai-controller';
import { GameState } from '../game-state';
import { createRng } from '../rng';
import type { FighterId, GameMode } from '../types';
import {
  ALL_FIGHTER_IDS,
  ATTACK_COOLDOWN_MS,
  FIGHTER_STATS,
  GROUND_Y,
  HURT_DURATION_MS,
  PALETTE,
  PIXEL_FONT_SIZES,
  TEAM_COLORS,
} from '../types';
import { BattleHud } from './BattleHud';

const FIGHTER_W = 48;
const FIGHTER_H = 64;
const FONT_HUD = '"Silkscreen", monospace';
const FONT_DISPLAY = '"Press Start 2P", monospace';

export class BattleScene extends Phaser.Scene {
  private gs!: GameState;
  private ais = new Map<FighterId, AiController>();
  private sprites = new Map<FighterId, Phaser.GameObjects.Rectangle>();
  private hud!: BattleHud;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private mode: GameMode = 'aivai';
  private seed = 0;
  private matchTimer = 99;
  private timerEvent!: Phaser.Time.TimerEvent;
  private battleStarted = false;
  private matchEnded = false;
  private fighterIds: FighterId[] = [];

  constructor() {
    super({ key: 'BattleScene' });
  }

  init(data: { mode?: GameMode; seed?: number; fighters?: FighterId[] }) {
    this.mode = data.mode ?? 'aivai';
    this.seed = data.seed ?? Date.now();
    this.fighterIds = data.fighters ?? (this.mode === 'aivai' ? [...ALL_FIGHTER_IDS] : ['opus46', 'codex']);

    this.gs = new GameState(this.fighterIds);

    // Create AI controllers (skip p1 in pvai mode)
    this.ais.clear();
    this.fighterIds.forEach((id, i) => {
      if (this.mode === 'pvai' && i === 0) return; // player controls first
      this.ais.set(id, new AiController(id, createRng(this.seed + i)));
    });

    this.matchTimer = 99;
    this.battleStarted = false;
    this.matchEnded = false;
  }

  preload() {
    this.load.image('bg', '/images/f090/background-cityscape.jpg');
  }

  create() {
    // Background
    const bg = this.add.image(320, 180, 'bg').setDisplaySize(640, 360);
    bg.setAlpha(0.25);

    // Ground line
    this.add.rectangle(320, GROUND_Y + FIGHTER_H / 2 + 4, 580, 2, 0x3a4658);

    // Fighter rectangles
    const slateColor = parseInt(PALETTE.slate.slice(1), 16);
    this.sprites.clear();
    for (const f of this.gs.fighters) {
      const teamColor = parseInt(TEAM_COLORS[f.id].slice(1), 16);
      const sprite = this.add
        .rectangle(f.x, GROUND_Y, FIGHTER_W, FIGHTER_H)
        .setStrokeStyle(2, teamColor)
        .setFillStyle(slateColor);
      this.sprites.set(f.id, sprite);
    }

    // HUD
    this.hud = new BattleHud(this);
    this.hud.create(this.gs.fighters);

    // ROUND text
    this.add
      .text(320, 120, 'ROUND 1', {
        fontFamily: FONT_DISPLAY,
        fontSize: PIXEL_FONT_SIZES.micro,
        color: PALETTE.bone,
      })
      .setOrigin(0.5);

    // Controls hint
    if (this.mode === 'pvai') {
      const hint = this.add
        .text(320, 350, 'A/D Move  |  J Attack  |  K Skill', {
          fontFamily: FONT_HUD,
          fontSize: PIXEL_FONT_SIZES.fighterName,
          color: PALETTE.steel,
        })
        .setOrigin(0.5);
      this.time.delayedCall(5000, () => {
        this.tweens.add({ targets: hint, alpha: 0, duration: 1000 });
      });
    } else {
      this.add
        .text(320, 350, 'AI vs AI  —  watching', {
          fontFamily: FONT_HUD,
          fontSize: PIXEL_FONT_SIZES.fighterName,
          color: PALETTE.steel,
        })
        .setOrigin(0.5);
    }

    // FIGHT! flash → start
    this.hud.showFight();
    this.time.delayedCall(1500, () => {
      this.hud.hideFight();
      this.battleStarted = true;
      this.timerEvent = this.time.addEvent({
        delay: 1000,
        callback: () => {
          this.matchTimer = Math.max(0, this.matchTimer - 1);
        },
        loop: true,
      });
    });

    // Keyboard input
    if (this.input.keyboard) {
      this.keys = {
        left: this.input.keyboard.addKey('A'),
        right: this.input.keyboard.addKey('D'),
        attack: this.input.keyboard.addKey('J'),
        skill: this.input.keyboard.addKey('K'),
      };
    }
  }

  update(_time: number, delta: number) {
    if (!this.battleStarted || this.matchEnded) return;

    if (this.matchTimer <= 0) {
      this.endMatch();
      return;
    }

    // Tick cooldowns for all fighters
    this.gs.tickCooldowns(delta);

    // Reduce attack cooldowns
    for (const f of this.gs.fighters) {
      f.attackCooldownMs = Math.max(0, f.attackCooldownMs - delta);
    }

    // Actions for each fighter
    for (const f of this.gs.fighters) {
      if (f.hp <= 0) continue; // dead fighters don't act
      if (f.stunMs > 0) continue; // stunned fighters can't act

      const ai = this.ais.get(f.id);
      const action: AiAction = ai ? ai.decide(this.gs) : this.getPlayerAction();
      this.applyAction(f.id, action, delta);
    }

    // Hit detection for each fighter
    for (const f of this.gs.fighters) {
      if (f.hp <= 0) continue;
      this.processHit(f.id);
      this.processSkillHit(f.id);
    }

    // Update visuals
    for (const f of this.gs.fighters) {
      const sprite = this.sprites.get(f.id);
      if (sprite) sprite.setPosition(f.x, GROUND_Y);
    }

    // Update HUD
    this.hud.update(this.gs.fighters, this.matchTimer);

    // Check game over
    if (this.gs.isOver()) {
      this.endMatch();
    }
  }

  private endMatch() {
    this.matchEnded = true;
    if (this.timerEvent) this.timerEvent.remove();

    const winnerId = this.gs.winner();
    const winnerName = winnerId ? this.gs.getFighter(winnerId).name : 'DRAW';
    const label = winnerId ? 'K.O.!' : 'TIME UP!';

    this.hud.showResult(label);
    this.hud.showSubtitle(winnerId ? `${winnerName} WINS!  —  Press R to restart` : 'Press R to restart');

    if (this.input.keyboard) {
      this.input.keyboard.once('keydown-R', () => {
        this.scene.restart({
          mode: this.mode,
          seed: this.seed,
          fighters: this.fighterIds,
        });
      });
    }
  }

  private getPlayerAction(): AiAction {
    if (!this.keys) return 'idle';
    if (this.keys.skill.isDown && this.gs.p1.skillCooldownMs <= 0) return 'skill';
    if (this.keys.attack.isDown && this.gs.p1.attackCooldownMs <= 0) return 'attack';
    if (this.keys.left.isDown) return 'move_left';
    if (this.keys.right.isDown) return 'move_right';
    return 'idle';
  }

  private applyAction(id: FighterId, action: AiAction, dt: number) {
    const fighter = this.gs.getFighter(id);
    const opp = this.gs.getOpponent(id);

    // Auto-face nearest opponent
    fighter.facing = opp.x > fighter.x ? 'right' : 'left';

    const speed = FIGHTER_STATS[id].moveSpeed;

    switch (action) {
      case 'move_left':
        fighter.x = Math.max(24, fighter.x - speed * (dt / 1000));
        fighter.state = 'run';
        break;
      case 'move_right':
        fighter.x = Math.min(616, fighter.x + speed * (dt / 1000));
        fighter.state = 'run';
        break;
      case 'attack':
        if (fighter.attackCooldownMs <= 0) {
          fighter.state = 'attack';
          fighter.attackCooldownMs = ATTACK_COOLDOWN_MS;
          this.gs.resetSwing(id);
        }
        break;
      case 'skill':
        this.gs.activateSkill(id);
        break;
      default:
        if (fighter.attackCooldownMs <= 0 && fighter.skillActiveMs <= 0) {
          fighter.state = 'idle';
        }
    }
  }

  private processHit(attackerId: FighterId) {
    const hit = this.gs.checkHit(attackerId);
    if (!hit) return;

    this.gs.applyDamage(hit.defenderId, hit.damage);
    this.gs.consumeHit(attackerId);
    this.flashSprite(hit.defenderId, 'danger');

    // Knockback
    const defender = this.gs.getFighter(hit.defenderId);
    const attacker = this.gs.getFighter(attackerId);
    const dir = defender.x > attacker.x ? 1 : -1;
    defender.x = Phaser.Math.Clamp(defender.x + dir * 20, 24, 616);

    attacker.state = 'idle';
  }

  private processSkillHit(attackerId: FighterId) {
    const fighter = this.gs.getFighter(attackerId);
    if (fighter.state !== 'skill') return;

    const hit = this.gs.checkSkillHit(attackerId);
    if (!hit) return;

    this.gs.applySkillEffect(attackerId, hit.defenderId);
    this.flashSprite(hit.defenderId, 'team', attackerId);

    // Reset attacker state after skill
    fighter.state = 'idle';
  }

  private flashSprite(targetId: FighterId, style: 'danger' | 'team', sourceId?: FighterId) {
    const sprite = this.sprites.get(targetId);
    if (!sprite) return;

    const slateColor = parseInt(PALETTE.slate.slice(1), 16);
    const flashColor =
      style === 'danger'
        ? parseInt(PALETTE.danger.slice(1), 16)
        : parseInt(TEAM_COLORS[sourceId ?? targetId].slice(1), 16);

    sprite.setFillStyle(flashColor);
    this.time.delayedCall(HURT_DURATION_MS, () => {
      sprite.setFillStyle(slateColor);
    });
  }
}
