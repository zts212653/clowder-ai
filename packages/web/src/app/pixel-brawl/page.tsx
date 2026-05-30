'use client';

/* eslint-disable cafe/no-hardcoded-colors -- Pixel-art game UI palette is intentionally
 * fixed 8-bit retro colors that do not participate in the F056 theme system.
 * The whole page is a self-contained demo, not part of the chat shell. */

import localFont from 'next/font/local';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type FighterId, PALETTE, PIXEL_FONT_SIZES, TEAM_COLORS } from '@/games/pixel-brawl/types';

type GameMode = 'pvai' | 'aivai';

const ALL_FIGHTERS: FighterId[] = ['opus46', 'opus45', 'codex', 'gpt54'];
const PVP_FIGHTERS: FighterId[] = ['opus46', 'codex'];

/** Page-level UI colors derived from the shared PALETTE (types.ts) +
 *  two page-only additions (pageBg, btnCyanText) not in the game engine. */
const PIXEL_PALETTE = {
  sceneBg: PALETTE.ink,
  pageBg: '#000',
  text: PALETTE.bone,
  title: PALETTE.flash,
  caption: PALETTE.steel,
  btnBg: PALETTE.slate,
  btnBorder: PALETTE.steel,
  btnCyanText: '#00F0FF',
  btnGreenText: TEAM_COLORS.codex,
} as const;

const pressStart2p = localFont({ src: '../../fonts/PressStart2P-Regular.woff2', weight: '400', display: 'swap' });
const silkscreen = localFont({
  src: [
    { path: '../../fonts/Silkscreen-Regular.woff2', weight: '400' },
    { path: '../../fonts/Silkscreen-Bold.woff2', weight: '700' },
  ],
  display: 'swap',
});

async function waitForPixelFonts(): Promise<void> {
  await Promise.all([
    document.fonts.load(`16px ${pressStart2p.style.fontFamily}`),
    document.fonts.load(`16px ${silkscreen.style.fontFamily}`),
  ]);
}

export default function PixelBrawlPage() {
  const gameContainerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const [started, setStarted] = useState(false);

  const startGame = useCallback(async (mode: GameMode) => {
    if (!gameContainerRef.current) return;

    gameRef.current?.destroy(true);

    // Ensure local self-hosted fonts are loaded before Phaser renders text.
    await waitForPixelFonts();

    const Phaser = (await import('phaser')).default;
    const { BattleScene } = await import('@/games/pixel-brawl/scenes/BattleScene');

    gameRef.current = new Phaser.Game({
      type: Phaser.CANVAS,
      width: 640,
      height: 360,
      zoom: 2,
      parent: gameContainerRef.current,
      backgroundColor: PIXEL_PALETTE.sceneBg,
      pixelArt: true,
      scene: [BattleScene],
    });

    const fighters = mode === 'aivai' ? ALL_FIGHTERS : PVP_FIGHTERS;
    gameRef.current.scene.start('BattleScene', {
      mode,
      seed: Date.now(),
      fighters,
    });
    setStarted(true);
  }, []);

  useEffect(() => {
    return () => {
      gameRef.current?.destroy(true);
    };
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        width: '100vw',
        height: '100vh',
        backgroundColor: PIXEL_PALETTE.pageBg,
        fontFamily: silkscreen.style.fontFamily,
      }}
    >
      {!started && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '24px',
            color: PIXEL_PALETTE.text,
          }}
        >
          <h1
            style={{
              fontSize: PIXEL_FONT_SIZES.title,
              color: PIXEL_PALETTE.title,
              margin: 0,
              letterSpacing: '2px',
              fontFamily: pressStart2p.style.fontFamily,
            }}
          >
            PIXEL BRAWL
          </h1>
          <p style={{ fontSize: PIXEL_FONT_SIZES.timer, color: PIXEL_PALETTE.caption, margin: 0 }}>
            Clowder AI Fighting Demo
          </p>
          <div style={{ display: 'flex', gap: '16px', marginTop: '16px' }}>
            <button
              type="button"
              onClick={() => startGame('aivai')}
              style={{
                padding: '12px 24px',
                backgroundColor: PIXEL_PALETTE.btnBg,
                color: PIXEL_PALETTE.btnCyanText,
                border: `2px solid ${PIXEL_PALETTE.btnBorder}`,
                fontFamily: silkscreen.style.fontFamily,
                fontSize: PIXEL_FONT_SIZES.button,
                cursor: 'pointer',
              }}
            >
              4-Cat Brawl (AI)
            </button>
            <button
              type="button"
              onClick={() => startGame('pvai')}
              style={{
                padding: '12px 24px',
                backgroundColor: PIXEL_PALETTE.btnBg,
                color: PIXEL_PALETTE.btnGreenText,
                border: `2px solid ${PIXEL_PALETTE.btnBorder}`,
                fontFamily: silkscreen.style.fontFamily,
                fontSize: PIXEL_FONT_SIZES.button,
                cursor: 'pointer',
              }}
            >
              Player vs AI
            </button>
          </div>
          <p style={{ fontSize: PIXEL_FONT_SIZES.micro, color: PIXEL_PALETTE.caption, margin: 0 }}>
            Player: A/D move | J attack | K skill | R restart
          </p>
        </div>
      )}
      <div ref={gameContainerRef} />
    </div>
  );
}
