'use client';

export interface MaintenanceData {
  checks: { key: string; label: string; count: number }[];
  pendingChecks: number;
  passedChecks: number;
  generatedAt: string;
}
