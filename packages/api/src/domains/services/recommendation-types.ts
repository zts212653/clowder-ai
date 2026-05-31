export type EnvOs = 'darwin' | 'win32' | 'linux';
export type EnvArch = 'arm64' | 'x64' | 'unsupported';
export type EnvGpu = 'apple' | 'cuda' | 'rocm' | 'none';
export type PythonArch = 'native' | 'x86-emulated' | 'missing';

export interface EnvironmentProfile {
  os: EnvOs;
  arch: EnvArch;
  /** Original `process.arch` value — populated when arch is 'unsupported' so error messages can report what was detected. */
  archRaw?: string;
  gpu: EnvGpu;
  gpuDetail?: string;
  pythonArch: PythonArch;
  pythonVersion?: string;
  ramGb: number;
  diskFreeGb: number;
  detectedAt: number;
}

export interface ResourceRequirement {
  ramGb: number;
  diskGb: number;
  gpu?: 'required' | 'recommended' | 'optional';
}

export interface ModelOption {
  name: string;
  size: string;
  description: string;
  requirements: ResourceRequirement;
  performance?: string;
}

export interface UnsupportedReason {
  reason: string;
  userAction: string;
  retryHint: string;
}

export interface MatchCriteria {
  os?: EnvOs | EnvOs[];
  arch?: EnvArch | EnvArch[];
  gpu?: EnvGpu | EnvGpu[];
  pythonArch?: PythonArch | PythonArch[];
}

export interface CustomModelHint {
  // Three-line structured hint shown beside the custom-model input. The
  // modal renders them in fixed order with bold labels so the user can
  // scan "what's expected / what's a good ID / what will fail".
  // - requirement: one-sentence description of the format/family the
  //   sidecar can load on this environment (no implementation jargon)
  // - example: one or more concrete model IDs that satisfy `requirement`
  // - unsupported: format(s) that will cause sidecar start to fail here
  requirement: string;
  example: string;
  unsupported?: string;
  links?: Array<{ label: string; url: string }>;
}

export interface MatrixEntry {
  match: MatchCriteria;
  models?: ModelOption[];
  unsupported?: UnsupportedReason;
  notes?: string[];
  customModelHint?: CustomModelHint;
}

export type ServiceMatrix = Record<string, MatrixEntry[]>;

export interface ServiceRecommendation {
  serviceId: string;
  profile: EnvironmentProfile;
  models: ModelOption[];
  unsupported?: UnsupportedReason;
  notes: string[];
  customModelHint?: CustomModelHint;
}
