# Orca provider icons

Copied/adapted from [stablyai/orca](https://github.com/stablyai/orca/tree/fe08eb9a23b8b9dab1d36afc2f4c94f3b1df5236), revision fe08eb9a23b8b9dab1d36afc2f4c94f3b1df5236.

- SVG components: src/renderer/src/components/status-bar/icons.tsx and src/renderer/src/lib/agent-icon-glyphs.tsx.
- Bundled PNGs: all 31 files selected by src/renderer/src/lib/agent-favicon-assets.ts, including Antigravity, Kimi, Grok, Cursor, ZCode, and the wider agent catalog. The matching 32 provider IDs are recorded in components/OrcaProviderAssets.ts.
- MiniMax: resources/minimax-icon.svg.
- Provider selection follows status-bar/tooltip.tsx and lib/agent-catalog.tsx.

OpenAI and OpenCode agent marks inherit the surrounding theme color; Claude and Kilo retain their fixed brand colors. Antigravity and other bundled image assets retain their original pixels. All assets are bundled locally; rendering makes no external requests.

Orca source is distributed under the accompanying MIT LICENSE. Provider trademarks remain owned by their respective owners.
