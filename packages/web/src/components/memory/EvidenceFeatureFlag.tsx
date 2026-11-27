'use client';

export interface EvidenceFlag {
  name: string;
  defaultValue: string;
  description: string;
  currentValue: string | null;
  allowedValues?: string[];
  /** Hub writes are opt-in; absence says nothing about the effective config owner. */
  runtimeEditable?: boolean;
  restartRequired?: boolean;
}
