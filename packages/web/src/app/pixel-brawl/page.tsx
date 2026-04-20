'use client';

import { Press_Start_2P, Silkscreen } from 'next/font/google';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FighterId } from '@/games/pixel-brawl/types';

type GameMode = 'pvai' | 'aivai';

const ALL_FIGHTERS: FighterId[] = ['opus46', 'opus45', 'codex', 'gpt54'];
const PVP_FIGHTERS: FighterId[] = ['opus46', 'codex'];

const pressStart2p = Press_Start_2P({ subsets: ['latin'], weight: '400', display: 'swap' });
const silkscreen = Silkscreen({ subsets: ['latin'], weight: ['400', '700'], display: 'swap' });

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
      backgroundColor: '#111318',
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
        backgroundColor: '#000',
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
            color: '#E8DFC7',
          }}
        >
          <h1
            style={{
              fontSize: '24px',
              color: '#F1E28A',
              margin: 0,
              letterSpacing: '2px',
              fontFamily: pressStart2p.style.fontFamily,
            }}
          >
            PIXEL BRAWL
          </h1>
          <p style={{ fontSize: '12px', color: '#3A4658', margin: 0 }}>Clowder AI Fighting Demo</p>
          <div style={{ display: 'flex', gap: '16px', marginTop: '16px' }}>
            <button
              type="button"
              onClick={() => startGame('aivai')}
              style={{
                padding: '12px 24px',
                backgroundColor: '#1E2430',
                color: '#00F0FF',
                border: '2px solid #3A4658',
                fontFamily: silkscreen.style.fontFamily,
                fontSize: '14px',
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
                backgroundColor: '#1E2430',
                color: '#2FA56E',
                border: '2px solid #3A4658',
                fontFamily: silkscreen.style.fontFamily,
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              Player vs AI
            </button>
          </div>
          <p style={{ fontSize: '10px', color: '#3A4658', margin: 0 }}>
            Player: A/D move | J attack | K skill | R restart
          </p>
        </div>
      )}
      <div ref={gameContainerRef} />
    </div>
  );
}
