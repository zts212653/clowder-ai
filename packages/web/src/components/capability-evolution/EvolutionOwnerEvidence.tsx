'use client';

import { ownerTruthRefV1Schema, refIdentity } from '@cat-cafe/shared';
import Image from 'next/image';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';

const captureRef = ownerTruthRefV1Schema.refine(
  (ref) => ref.ownerFeatureId === 'microduck-owner' && /^capture:sha256:[a-f0-9]{64}$/u.test(ref.ownerStateRef),
);
const manifestSchema = z
  .object({
    manifestVersion: z.literal('f311-microduck-show-v1'),
    programRef: ownerTruthRefV1Schema,
    programSequence: z.number().int().nonnegative(),
    sceneMedia: z
      .array(
        z
          .object({
            sceneIndex: z.number().int().min(0).max(7),
            source: z.literal('real_capture'),
            captureRef,
            kind: z.literal('image'),
            assetUrl: z.string(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

interface OwnerEvidenceProjection {
  program: {
    programId: string;
    sequence: number;
    objectRef: { ownerFeatureId: string; ownerStateRef: string; version?: string };
  };
}

function canonicalMediaUrl(programId: string, sceneIndex: number): string {
  return `/api/capability-evolution/programs/${encodeURIComponent(programId)}/adapter-media/${sceneIndex}`;
}

export function EvolutionOwnerEvidence({ projection }: { projection: OwnerEvidenceProjection }) {
  const [assetUrl, setAssetUrl] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const { programId, sequence, objectRef } = projection.program;
  useEffect(() => {
    setAssetUrl(undefined);
    setLoaded(false);
    if (objectRef.ownerFeatureId !== 'microduck-owner') return;
    let active = true;
    void apiFetch(`/api/capability-evolution/programs/${encodeURIComponent(programId)}/adapter-manifest`)
      .then(async (response) => (response.ok ? manifestSchema.safeParse(await response.json()) : undefined))
      .then((parsed) => {
        if (!active || !parsed?.success) return;
        const manifest = parsed.data;
        if (
          manifest.programSequence !== sequence ||
          refIdentity(manifest.programRef) !== refIdentity({ ownerFeatureId: 'F311', ownerStateRef: programId })
        ) {
          return;
        }
        const media = manifest.sceneMedia?.find(
          (item) => item.assetUrl === canonicalMediaUrl(programId, item.sceneIndex),
        );
        if (media) setAssetUrl(media.assetUrl);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [objectRef.ownerFeatureId, programId, sequence]);
  if (objectRef.ownerFeatureId !== 'microduck-owner' || !assetUrl) return null;
  return (
    <figure className="mt-6 overflow-hidden rounded-2xl border border-cafe-subtle bg-cafe-surface-sunken">
      <Image
        src={assetUrl}
        alt="Microduck 在模拟器中的 owner 运行证据"
        width={1200}
        height={702}
        unoptimized
        className="aspect-video w-full object-cover"
        onLoad={() => setLoaded(true)}
        onError={() => {
          setLoaded(false);
          setAssetUrl(undefined);
        }}
      />
      <figcaption className="space-y-1 px-4 py-3">
        <p className="text-xs font-semibold text-cafe-secondary">
          {loaded ? '真实模拟运行 · owner 证据' : '正在核对 owner 媒体…'}
        </p>
        <p className="text-xs leading-5 text-cafe-muted">
          现有 walking ONNX 的单次模拟截图；本地推理 smoke 已通过，但这不是步态鲁棒性评估。
        </p>
      </figcaption>
    </figure>
  );
}
