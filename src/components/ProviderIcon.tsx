import React from 'react';

export type KnownProvider = 'codex' | 'antigravity' | 'claude' | 'opencode' | 'kilo' | 'unknown';

interface ProviderIconProps {
  provider: string | null | undefined;
  className?: string;
  size?: number;
  showLabel?: boolean;
}

export function normalizeProvider(provider: string | null | undefined): {
  id: KnownProvider;
  displayName: string;
} {
  if (!provider || typeof provider !== 'string') {
    return { id: 'unknown', displayName: 'Unknown' };
  }

  const raw = provider.trim();
  const lower = raw.toLowerCase();

  if (lower === 'codex' || lower === 'openai' || lower.startsWith('codex-') || lower.startsWith('gpt-')) {
    return { id: 'codex', displayName: raw };
  }
  if (lower === 'antigravity' || lower === 'agy' || lower === 'gemini' || lower.startsWith('antigravity-')) {
    return { id: 'antigravity', displayName: raw };
  }
  if (lower === 'claude' || lower === 'anthropic' || lower.startsWith('claude-')) {
    return { id: 'claude', displayName: raw };
  }
  if (lower === 'opencode' || lower === 'open-code') {
    return { id: 'opencode', displayName: raw };
  }
  if (lower === 'kilo' || lower === 'kilocode' || lower === 'kilo-code') {
    return { id: 'kilo', displayName: raw };
  }

  return { id: 'unknown', displayName: raw };
}

export const ProviderIcon: React.FC<ProviderIconProps> = ({
  provider,
  className = '',
  size = 16,
  showLabel = false,
}) => {
  const { id, displayName } = normalizeProvider(provider);

  const renderSvg = () => {
    switch (id) {
      case 'codex':
        // Official OpenAI / Codex 6-fold knot mark (Source: https://openai.com/brand/)
        return (
          <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="currentColor"
            className={`provider-svg provider-codex ${className}`}
            aria-hidden="true"
          >
            <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
          </svg>
        );

      case 'antigravity':
        // Official Google Antigravity gravity-well arch mark (Source: https://antigravity.google/press & https://antigravity.google/favicon.svg)
        return (
          <svg
            width={size}
            height={size}
            viewBox="10 16 90 82"
            fill="currentColor"
            className={`provider-svg provider-antigravity ${className}`}
            aria-hidden="true"
          >
            <path d="M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z" />
          </svg>
        );

      case 'claude':
        // Official Anthropic Claude sunburst mark (Source: https://claude.com/)
        return (
          <svg
            width={size}
            height={size}
            viewBox="0 0 126 126"
            fill="currentColor"
            className={`provider-svg provider-claude ${className}`}
            aria-hidden="true"
          >
            <path d="M54.375 118.75L56.125 111L58.125 101L59.75 93L61.25 83.125L62.125 79.875L62 79.625L61.375 79.75L53.875 90L42.5 105.375L33.5 114.875L31.375 115.75L27.625 113.875L28 110.375L30.125 107.375L42.5 91.5L50 81.625L54.875 76L54.75 75.25H54.5L21.5 96.75L15.625 97.5L13 95.125L13.375 91.25L14.625 90L24.5 83.125L49.125 69.375L49.5 68.125L49.125 67.5H47.875L43.75 67.25L29.75 66.875L17.625 66.375L5.75 65.75L2.75 65.125L0 61.375L0.25 59.5L2.75 57.875L6.375 58.125L14.25 58.75L26.125 59.5L34.75 60L47.5 61.375H49.5L49.75 60.5L49.125 60L48.625 59.5L36.25 51.25L23 42.5L16 37.375L12.25 34.75L10.375 32.375L9.625 27.125L13 23.375L17.625 23.75L18.75 24L23.375 27.625L33.25 35.25L46.25 44.875L48.125 46.375L49 45.875V45.5L48.125 44.125L41.125 31.375L33.625 18.375L30.25 13L29.375 9.75C29.0417 8.625 28.875 7.375 28.875 6L32.75 0.750006L34.875 0L40.125 0.750006L42.25 2.625L45.5 10L50.625 21.625L58.75 37.375L61.125 42.125L62.375 46.375L62.875 47.75H63.75V47L64.375 38L65.625 27.125L66.875 13.125L67.25 9.125L69.25 4.375L73.125 1.87501L76.125 3.25L78.625 6.875L78.25 9.125L76.875 18.75L73.875 33.875L72 44.125H73.125L74.375 42.75L79.5 36L88.125 25.25L91.875 21L96.375 16.25L99.25 14H104.625L108.5 19.875L106.75 26L101.25 33L96.625 38.875L90 47.75L86 54.875L86.375 55.375H87.25L102.125 52.125L110.25 50.75L119.75 49.125L124.125 51.125L124.625 53.125L122.875 57.375L112.625 59.875L100.625 62.25L82.75 66.5L82.5 66.625L82.75 67L90.75 67.75L94.25 68H102.75L118.5 69.125L122.625 71.875L125 75.125L124.625 77.75L118.25 80.875L109.75 78.875L89.75 74.125L83 72.5H82V73L87.75 78.625L98.125 88L111.25 100.125L111.875 103.125L110.25 105.625L108.5 105.375L97 96.625L92.5 92.75L82.5 84.375H81.875V85.25L84.125 88.625L96.375 107L97 112.625L96.125 114.375L92.875 115.5L89.5 114.875L82.25 104.875L74.875 93.5L68.875 83.375L68.25 83.875L64.625 121.625L63 123.5L59.25 125L56.125 122.625L54.375 118.75Z" />
          </svg>
        );

      case 'opencode':
        // Official OpenCode identity mark (Source: https://github.com/anomalyco/opencode/packages/identity/mark.svg & https://opencode.ai/brand)
        return (
          <svg
            width={size}
            height={size}
            viewBox="120 90 270 330"
            fill="none"
            className={`provider-svg provider-opencode ${className}`}
            aria-hidden="true"
          >
            <path d="M320 224V352H192V224H320Z" fill="currentColor" opacity="0.6" />
            <path fillRule="evenodd" clipRule="evenodd" d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z" fill="currentColor" />
          </svg>
        );

      case 'kilo':
        // Official Kilo Code block mark (Source: https://kilo.ai/favicon/favicon.svg & https://github.com/Kilo-Org/kilocode)
        return (
          <svg
            width={size}
            height={size}
            viewBox="0 0 32 32"
            fill="currentColor"
            className={`provider-svg provider-kilo ${className}`}
            aria-hidden="true"
          >
            <g fill="currentColor">
              <path d="M23,26v-2h3v-5l-2-2h-4v2h-3v5l2,2h4ZM20,20h3v3h-3v-3Z" />
              <rect x="12" y="17" width="3" height="3" />
              <polygon points="26 12 23 12 23 9 20 6 17 6 17 9 20 9 20 12 17 12 17 15 26 15 26 12" />
              <path d="M0,0v32h32V0H0ZM29,29H3V3h26v26Z" />
              <polygon points="15 26 15 23 9 23 9 17 6 17 6 23.1875 8.8125 26 15 26" />
              <rect x="12" y="6" width="3" height="3" />
              <polygon points="9 12 12 12 12 15 15 15 15 12 12 9 9 9 9 6 6 6 6 15 9 15 9 12" />
            </g>
          </svg>
        );

      case 'unknown':
      default:
        // Generic chip / cube icon
        return (
          <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`provider-svg provider-unknown ${className}`}
            aria-hidden="true"
          >
            <rect x="4" y="4" width="16" height="16" rx="3" />
            <circle cx="12" cy="12" r="2.5" />
            <line x1="12" y1="2" x2="12" y2="4" />
            <line x1="12" y1="20" x2="12" y2="22" />
            <line x1="2" y1="12" x2="4" y2="12" />
            <line x1="20" y1="12" x2="22" y2="12" />
          </svg>
        );
    }
  };

  return (
    <span className="provider-badge" title={`Provider: ${displayName}`}>
      {renderSvg()}
      {showLabel && <span className="provider-label font-mono">{displayName}</span>}
    </span>
  );
};
