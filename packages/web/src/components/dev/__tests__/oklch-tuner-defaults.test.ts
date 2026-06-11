import { describe, expect, it } from 'vitest';
import { exportText } from '../oklch-tuner-css';
import { INIT_DARK, INIT_LIGHT } from '../oklch-tuner-engine';

describe('OKLCH tuner defaults', () => {
  it('exports the CVO-tuned light token defaults', () => {
    expect(exportText(INIT_LIGHT, 'light')).toBe(
      [
        'OKLCH Token Values (light)',
        'accent H=50 C=0.14',
        'surface H=80 C*=1',
        '==============================',
        'light:',
        '  primary   L=0.62  C*1.00',
        '  surface   L=0.85  C*0.45',
        '  text      L=0.24  C*0.80',
        '  inset     L=0.25  C*0.15',
        '  ring      L=0.55  C*1.10',
        '  insetText L=0.85  C=0.030',
        '  msgText   L=0.25  C=0.010',
        '  elevation: 0.92/0.95/0.99/0.995',
        '',
        'semantic (light):',
        '  H: crit=35 suc=135 warn=45 info=210  L=0.55 C=0.120 surfL=0.96 surfC=0.030',
        'queue: H=300 C=0.12 L=0.5',
        'neutral: H=30 C=0.005  txt=0.2 sec=0.45 mut=0.56 int=0.36 bdr=0.84 sub=0.915 codeBg=0.9 codeTx=0.19',
        'catText: H=5 C=0.025 L=0.15',
      ].join('\n'),
    );
  });

  it('exports the CVO-tuned dark token defaults', () => {
    expect(exportText(INIT_DARK, 'dark')).toBe(
      [
        'OKLCH Token Values (dark)',
        'accent H=35 C=0.08',
        'surface H=30 C*=0.15',
        '==============================',
        'dark:',
        '  primary   L=0.68  C*0.85',
        '  surface   L=0.30  C*0.15',
        '  text      L=0.88  C*0.60',
        '  inset     L=0.24  C*0.10',
        '  ring      L=0.70  C*1.00',
        '  insetText L=0.80  C=0.020',
        '  msgText   L=0.80  C=0.040',
        '  elevation: 0.36/0.28/0.21/0.24',
        '',
        'semantic (dark):',
        '  H: crit=25 suc=145 warn=70 info=230  L=0.70 C=0.170 surfL=0.25 surfC=0.050',
        'queue: H=290 C=0.15 L=0.6',
        'neutral: H=30 C=0.005  txt=0.95 sec=0.75 mut=0.66 int=0.84 bdr=0.35 sub=0.4 codeBg=0.25 codeTx=0.9',
        'catText: H=25 C=0.1 L=0.95',
      ].join('\n'),
    );
  });
});
