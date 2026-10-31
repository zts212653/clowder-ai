import type { InstallPreviewText } from './install-preview.shell-copy';

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

export interface EnvironmentProfile {
  os: 'darwin' | 'win32' | 'linux';
  arch: 'arm64' | 'x64';
  gpu: 'apple' | 'cuda' | 'rocm' | 'none';
  gpuDetail?: string;
  pythonArch: 'native' | 'x86-emulated';
  pythonVersion?: string;
  ramGb: number;
  diskFreeGb: number;
  detectedAt: number;
}

export interface CustomModelHint {
  requirement: string;
  example: string;
  unsupported?: string;
  links?: Array<{ label: string; url: string }>;
}

export interface ServiceRecommendation {
  serviceId: string;
  profile: EnvironmentProfile;
  models: ModelOption[];
  unsupported?: UnsupportedReason;
  notes: string[];
  customModelHint?: CustomModelHint;
}

const OS_LABEL: Record<EnvironmentProfile['os'], string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

function formatRequirement(req: ResourceRequirement, copy: InstallPreviewText): string {
  const parts = [copy.model.memory(req.ramGb), copy.model.disk(req.diskGb)];
  if (req.gpu === 'required') parts.push(copy.model.gpuRequired);
  else if (req.gpu === 'recommended') parts.push(copy.model.gpuRecommended);
  return parts.join(' · ');
}

export function EnvSummary({ profile, copy }: { profile: EnvironmentProfile; copy: InstallPreviewText }) {
  const gpuLabel = copy.environment.gpuLabels[profile.gpu];
  const pythonArch =
    profile.pythonArch === 'x86-emulated'
      ? copy.environment.pythonArch.x86Emulated
      : copy.environment.pythonArch.native;
  return (
    <div className="rounded-lg bg-[var(--console-field-bg)] px-4 py-3 space-y-1">
      <p className="text-micro font-semibold uppercase tracking-wider text-cafe-muted">{copy.environment.title}</p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-cafe-secondary">
        <span>
          <span className="text-cafe font-medium">{copy.environment.system}</span> {OS_LABEL[profile.os]} {profile.arch}
        </span>
        <span>
          <span className="text-cafe font-medium">{copy.environment.gpu}</span> {gpuLabel}
        </span>
        <span>
          <span className="text-cafe font-medium">{copy.environment.memory}</span> {profile.ramGb}GB
        </span>
        <span>
          <span className="text-cafe font-medium">{copy.environment.disk}</span> {profile.diskFreeGb}GB
        </span>
        <span className="col-span-2">
          <span className="text-cafe font-medium">{copy.environment.python}</span>{' '}
          {profile.pythonVersion ? `${profile.pythonVersion} (${pythonArch})` : copy.environment.pythonMissing}
        </span>
      </div>
    </div>
  );
}

export function UnsupportedPanel({ info, copy }: { info: UnsupportedReason; copy: InstallPreviewText }) {
  return (
    <div className="rounded-lg border border-conn-red-border bg-conn-red-bg/40 px-4 py-3 space-y-2">
      <p className="text-micro font-semibold uppercase tracking-wider text-conn-red-text">{copy.unsupported.title}</p>
      <p className="text-sm text-cafe">{info.reason}</p>
      <div className="rounded bg-cafe-surface px-3 py-2 space-y-1">
        <p className="text-xs text-cafe">
          <span className="font-medium">{copy.unsupported.action}</span> {info.userAction}
        </p>
        <p className="text-micro text-cafe-muted">{info.retryHint}</p>
      </div>
    </div>
  );
}

interface ModelSelectorProps {
  models: ModelOption[];
  recommendedName?: string;
  selectedModel: string;
  useCustom: boolean;
  customModel: string;
  customModelHint?: CustomModelHint;
  copy: InstallPreviewText;
  onSelect: (name: string) => void;
  onToggleCustom: (value: boolean) => void;
  onCustomChange: (value: string) => void;
}

export function ModelSelector(props: ModelSelectorProps) {
  const { models, recommendedName, selectedModel, useCustom, customModel, customModelHint, copy } = props;
  return (
    <div className="rounded-lg bg-[var(--console-field-bg)] px-4 py-3 space-y-2">
      <p className="text-micro font-semibold uppercase tracking-wider text-cafe-muted">{copy.model.title}</p>
      <div className="space-y-1.5">
        {models.map((model) => {
          const recommended = model.name === recommendedName;
          const checked = !useCustom && selectedModel === model.name;
          return (
            <label
              key={model.name}
              className={`flex items-start gap-2 rounded-lg px-3 py-2 cursor-pointer transition-colors ${
                checked ? 'bg-[var(--console-card-bg)] shadow-sm' : 'hover:bg-[var(--console-card-bg)]/50'
              }`}
            >
              <input
                type="radio"
                name="model"
                checked={checked}
                onChange={() => {
                  props.onSelect(model.name);
                  props.onToggleCustom(false);
                }}
                className="mt-1 accent-[var(--color-cafe-accent)]"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <p className="text-sm font-medium text-cafe truncate">{model.name.split('/').pop()}</p>
                  {recommended && (
                    <span className="text-micro px-1.5 py-0.5 rounded bg-conn-emerald-bg text-conn-emerald-text">
                      {copy.model.recommended}
                    </span>
                  )}
                </div>
                <p className="text-micro text-cafe-muted">
                  {model.size} · {formatRequirement(model.requirements, copy)}
                </p>
                <p className="text-micro text-cafe-muted">{model.description}</p>
                {model.performance && <p className="text-micro text-cafe-muted italic">{model.performance}</p>}
              </div>
            </label>
          );
        })}
        <label
          className={`flex items-start gap-2 rounded-lg px-3 py-2 cursor-pointer transition-colors ${
            useCustom ? 'bg-[var(--console-card-bg)] shadow-sm' : 'hover:bg-[var(--console-card-bg)]/50'
          }`}
        >
          <input
            type="radio"
            name="model"
            checked={useCustom}
            onChange={() => props.onToggleCustom(true)}
            className="mt-1 accent-[var(--color-cafe-accent)]"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-cafe">{copy.model.custom}</p>
            {useCustom && (
              <>
                <input
                  type="text"
                  value={customModel}
                  onChange={(event) => props.onCustomChange(event.target.value)}
                  placeholder="org/model-name"
                  className="mt-1 w-full border border-[var(--console-border-soft)] rounded-md px-2 py-1 text-xs bg-[var(--console-card-bg)] focus:outline-none focus:ring-1 focus:ring-conn-sky-ring"
                />
                {customModelHint && (
                  <div className="mt-1 space-y-0.5">
                    <p className="text-micro text-cafe-muted leading-relaxed">
                      <span className="font-semibold text-cafe">{copy.model.format}</span>
                      {customModelHint.requirement}
                    </p>
                    <p className="text-micro text-cafe-muted leading-relaxed">
                      <span className="font-semibold text-cafe">{copy.model.example}</span>
                      {customModelHint.example}
                    </p>
                    {customModelHint.unsupported && (
                      <p className="text-micro leading-relaxed text-conn-amber-text">
                        <span className="font-semibold">{copy.model.unsupported}</span>
                        {customModelHint.unsupported}
                        {copy.model.willFail}
                      </p>
                    )}
                    {customModelHint.links && customModelHint.links.length > 0 && (
                      <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                        {customModelHint.links.map((link) => (
                          <a
                            key={link.url}
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(event) => event.stopPropagation()}
                            className="text-micro text-conn-sky-text hover:underline"
                          >
                            ↗ {link.label}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </label>
      </div>
    </div>
  );
}
