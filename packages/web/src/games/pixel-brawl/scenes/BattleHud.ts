import * as Phaser from 'phaser';
import type { Fighter, FighterId } from '../types';
import { FIGHTER_STATS, PALETTE, PIXEL_FONT_SIZES, SKILLS, TEAM_COLORS } from '../types';

const HP_BAR_W = 120;
const HP_BAR_H = 10;
const SKILL_BAR_H = 4;
const FONT_HUD = '"Silkscreen", monospace';
const FONT_DISPLAY = '"Press Start 2P", monospace';

interface FighterHud {
  hpBg: Phaser.GameObjects.Rectangle;
  hpBar: Phaser.GameObjects.Rectangle;
  skillBar: Phaser.GameObjects.Rectangle;
  nameText: Phaser.GameObjects.Text;
  label: Phaser.GameObjects.Text;
}

export class BattleHud {
  private huds = new Map<FighterId, FighterHud>();
  private timerText!: Phaser.GameObjects.Text;
  private centerText!: Phaser.GameObjects.Text;
  private subtitleText!: Phaser.GameObjects.Text;

  constructor(private scene: Phaser.Scene) {}

  create(fighters: Fighter[]): void {
    const slateColor = parseInt(PALETTE.slate.slice(1), 16);
    const steelColor = parseInt(PALETTE.steel.slice(1), 16);

    // Position HP bars: spread across top based on fighter count
    const count = fighters.length;
    const spacing = 640 / (count + 1);

    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i];
      const cx = Math.round(spacing * (i + 1));
      const teamColor = parseInt(TEAM_COLORS[f.id].slice(1), 16);

      // Name above HP bar
      const nameText = this.scene.add
        .text(cx, 4, f.name, {
          fontFamily: FONT_HUD,
          fontSize: PIXEL_FONT_SIZES.fighterName,
          color: TEAM_COLORS[f.id],
        })
        .setOrigin(0.5, 0);

      // HP bar background
      const hpBg = this.scene.add
        .rectangle(cx - HP_BAR_W / 2, 16, HP_BAR_W + 4, HP_BAR_H + 4, slateColor)
        .setStrokeStyle(1, steelColor)
        .setOrigin(0, 0);

      // HP bar fill
      const hpBar = this.scene.add.rectangle(cx - HP_BAR_W / 2 + 2, 18, HP_BAR_W, HP_BAR_H, teamColor).setOrigin(0, 0);

      // Skill cooldown bar (thin, below HP)
      const skillColor = Phaser.Display.Color.IntegerToColor(teamColor).brighten(30).color;
      const skillBar = this.scene.add
        .rectangle(cx - HP_BAR_W / 2 + 2, 30, HP_BAR_W, SKILL_BAR_H, skillColor)
        .setOrigin(0, 0);

      // Fighter label (under the sprite, positioned later)
      const label = this.scene.add
        .text(f.x, 340, f.name, {
          fontFamily: FONT_HUD,
          fontSize: PIXEL_FONT_SIZES.fighterLabel,
          color: TEAM_COLORS[f.id],
        })
        .setOrigin(0.5, 0);

      this.huds.set(f.id, { hpBg, hpBar, skillBar, nameText, label });
    }

    // Timer (centered)
    this.timerText = this.scene.add
      .text(320, 6, '99', {
        fontFamily: FONT_DISPLAY,
        fontSize: PIXEL_FONT_SIZES.timer,
        color: PALETTE.flash,
      })
      .setOrigin(0.5, 0)
      .setDepth(10);

    // Center text (FIGHT!, K.O., etc.)
    this.centerText = this.scene.add
      .text(320, 150, '', {
        fontFamily: FONT_DISPLAY,
        fontSize: PIXEL_FONT_SIZES.center,
        color: PALETTE.flash,
      })
      .setOrigin(0.5)
      .setDepth(10);

    // Subtitle text (winner name, restart hint)
    this.subtitleText = this.scene.add
      .text(320, 190, '', {
        fontFamily: FONT_HUD,
        fontSize: PIXEL_FONT_SIZES.subtitle,
        color: PALETTE.steel,
      })
      .setOrigin(0.5)
      .setDepth(10);
  }

  update(fighters: Fighter[], timer: number): void {
    this.timerText.setText(String(timer));

    for (const f of fighters) {
      const hud = this.huds.get(f.id);
      if (!hud) continue;

      // HP bar width proportional to HP
      hud.hpBar.setSize(HP_BAR_W * (f.hp / f.maxHp), HP_BAR_H);

      // Skill bar: full when ready (cooldown = 0), empties as cooldown ticks
      const skillDef = SKILLS[FIGHTER_STATS[f.id].skillId];
      const skillPct = f.skillCooldownMs <= 0 ? 1 : 1 - f.skillCooldownMs / skillDef.cooldownMs;
      hud.skillBar.setSize(HP_BAR_W * skillPct, SKILL_BAR_H);

      // Update label position to follow fighter
      hud.label.setPosition(f.x, 340);
    }
  }

  showFight(): void {
    this.centerText.setText('FIGHT!');
  }

  hideFight(): void {
    this.centerText.setText('');
  }

  showResult(label: string): void {
    this.centerText.setText(label);
  }

  showSubtitle(text: string): void {
    this.subtitleText.setText(text);
  }
}
