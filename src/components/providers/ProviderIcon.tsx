import React from 'react';
import { AgentLetterIcon, AiderIcon, ClaudeIcon, CopilotIcon, DroidIcon, GeminiIcon, KiloIcon, MiniMaxIcon, OmpIcon, OpenAIIcon, OpenCodeGoIcon, OpenCodeIcon, PiIcon } from './OrcaProviderGlyphs';
import { ORCA_PROVIDER_IMAGES } from './OrcaProviderAssets';

export type KnownProvider = keyof typeof ORCA_PROVIDER_IMAGES | keyof typeof glyphs | 'unknown';

interface ProviderIconProps {
  provider: string | null | undefined;
  className?: string;
  size?: number;
  showLabel?: boolean;
}

export function normalizeProvider(provider: string | null | undefined): { id: KnownProvider; displayName: string } {
  if (!provider || typeof provider !== 'string') return { id: 'unknown', displayName: 'Unknown' };
  const raw = provider.trim();
  const lower = raw.toLowerCase();
  let id: KnownProvider = 'unknown';
  if (lower === 'codex' || lower === 'openai' || lower.startsWith('codex-') || lower.startsWith('gpt-')) id = 'codex';
  else if (lower === 'antigravity' || lower === 'agy' || lower.startsWith('antigravity-')) id = 'antigravity';
  else if (lower === 'gemini' || lower.startsWith('gemini-')) id = 'gemini';
  else if (lower === 'claude' || lower === 'anthropic' || lower.startsWith('claude-')) id = 'claude';
  else if (lower === 'opencode-go' || lower === 'opencodego') id = 'opencode-go';
  else if (lower === 'opencode' || lower === 'open-code' || lower === 'opencode2') id = 'opencode';
  else if (lower === 'kilo' || lower === 'kilocode' || lower === 'kilo-code') id = 'kilo';
  else if (lower === 'dsb') id = 'dsh';
  else if (lower in imageAssets || lower in glyphs) id = lower as KnownProvider;
  return { id, displayName: raw };
}

const imageAssets = ORCA_PROVIDER_IMAGES;
const glyphs = {
  codex: OpenAIIcon, claude: ClaudeIcon, gemini: GeminiIcon, minimax: MiniMaxIcon,
  opencode: OpenCodeIcon, 'opencode-go': OpenCodeGoIcon, kilo: KiloIcon,
  droid: DroidIcon, pi: PiIcon, omp: OmpIcon, aider: AiderIcon, copilot: CopilotIcon,
} satisfies Record<string, React.ComponentType<{ size?: number }>>;

export const ProviderIcon: React.FC<ProviderIconProps> = ({ provider, className = '', size = 16, showLabel = false }) => {
  const { id, displayName } = normalizeProvider(provider);
  const image = imageAssets[id as keyof typeof imageAssets];
  const Glyph = glyphs[id as keyof typeof glyphs];
  return (
    <span className="provider-badge" title={`Provider: ${displayName}`}>
      <span className={`provider-svg provider-${id} ${className}`} aria-hidden="true"
        style={{ width: size, height: size, color: 'var(--text-main)', display: 'inline-flex' }}>
        {Glyph ? <Glyph size={size} /> : image ? <img src={image} width={size} height={size} alt="" style={{ borderRadius: 2 }} /> :
          <AgentLetterIcon letter="?" size={size} />}
      </span>
      {showLabel && <span className="provider-label font-mono">{displayName}</span>}
    </span>
  );
};
