'use client';

import type { FC, ReactNode } from 'react';
import { PdlAppHost } from '@/pdl/PdlAppHost';

export const AppShell: FC<{ children: ReactNode }> = () => <PdlAppHost />;
