import React from 'react';
import { Icon } from '../ui/Icon';
import { AgentLetterIcon, ClaudeIcon, FreebuffIcon, GeminiIcon, KiloIcon, OpenAIIcon, OpenCodeGoIcon, OpenCodeIcon } from './ProviderGlyphs';
import { PROVIDER_IMAGES } from './ProviderAssets';

export type KnownProvider = keyof typeof PROVIDER_IMAGES | keyof typeof glyphs | 'unknown';

interface ProviderIconProps {
  provider: string | null | undefined;
  className?: string;
  size?: number;
  showLabel?: boolean;
  liveness?: string;
}

export function normalizeProvider(provider: string | null | undefined): { id: KnownProvider; displayName: string } {
  if (!provider || typeof provider !== 'string') return { id: 'unknown', displayName: 'Unknown' };
  const raw = provider.trim();
  const lower = raw.toLowerCase();
  let id: KnownProvider = 'unknown';
  if (lower === 'codex' || lower === 'openai' || lower.startsWith('codex-') || lower.startsWith('gpt-')) id = 'codex';
  else if (lower === 'antigravity' || lower === 'agy' || lower.startsWith('antigravity-')) id = 'antigravity';
  else if (lower === 'codebuddy') id = 'codebuddy';
  else if (lower === 'gemini' || lower.startsWith('gemini-')) id = 'gemini';
  else if (lower === 'claude' || lower === 'anthropic' || lower.startsWith('claude-') || lower === 'openclaude' || lower === 'claude-agent-teams') id = 'claude';
  else if (lower === 'opencode-go' || lower === 'opencodego') id = 'opencode-go';
  else if (lower === 'opencode' || lower === 'open-code' || lower === 'opencode2') id = 'opencode';
  else if (lower === 'kilo' || lower === 'kilocode' || lower === 'kilo-code') id = 'kilo';
  else if (lower === 'dsb' || lower === 'dsh') id = 'dsh';
  else if (lower === 'freebuff') id = 'freebuff';
  else if (lower in imageAssets || lower in glyphs) id = lower as KnownProvider;
  return { id, displayName: raw };
}

const imageAssets = PROVIDER_IMAGES;
const glyphs = {
  codex: OpenAIIcon,
  claude: ClaudeIcon,
  gemini: GeminiIcon,
  opencode: OpenCodeIcon,
  'opencode-go': OpenCodeGoIcon,
  kilo: KiloIcon,
  freebuff: FreebuffIcon,
} satisfies Record<string, React.ComponentType<{ size?: number }>>;

export const ProviderIcon: React.FC<ProviderIconProps> = ({ provider, className = '', size = 16, showLabel = false, liveness }) => {
  if (provider === 'terminal') return <span className={`provider-badge terminal-provider-icon ${liveness === 'live' ? 'is-live' : 'is-stopped'} ${className}`} title={liveness === 'live' ? 'Terminal process running' : liveness === 'exited' ? 'Terminal process stopped' : 'Terminal process status unknown'}><Icon name="terminal" size={size} />{showLabel && <span>Terminal</span>}</span>;
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
