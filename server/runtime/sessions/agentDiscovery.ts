import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AdeProvider, AgentCatalogResponse, TerminalShell } from '../../../shared/contracts.js';

export const PROVIDERS: { id: AdeProvider; name: string; command: string; package?: string; entry?: string }[] = [
  { id: 'codex', name: 'Codex', command: 'codex', package: '@openai/codex', entry: 'bin/codex.js' },
  { id: 'claude', name: 'Claude Code', command: 'claude', package: '@anthropic-ai/claude-code', entry: 'cli.js' },
  { id: 'antigravity', name: 'Antigravity', command: 'agy' },
  { id: 'codebuddy', name: 'CodeBuddy', command: 'codebuddy', package: '@tencent-ai/codebuddy-code', entry: 'bin/codebuddy' },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', package: 'opencode-ai', entry: 'bin/opencode' },
  { id: 'opencode2', name: 'OpenCode 2', command: 'opencode2', package: 'opencode-ai', entry: 'bin/opencode2' },
  { id: 'kilo', name: 'Kilo Code', command: 'kilo', package: '@kilocode/cli', entry: 'bin/kilo' },
  { id: 'dsh', name: 'DeepSeek Harness', command: 'dsh-tui', package: '@deepseek-harness-tui/dsh-tui', entry: 'bin/dsh-tui.js' },
  { id: 'terminal', name: 'Terminal', command: 'terminal' },
];

export const TERMINAL_SHELLS: TerminalShell[] = ['powershell', 'cmd', 'bash'];
const POWERSHELL_PROMPT = "function global:prompt { $h = Get-History -Count 1; if ($h) { $b = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($h.CommandLine)); [Console]::Write([char]27 + ']7502;' + $env:ADE_STATUS_TOKEN + ';' + $b + [char]7) }; 'PS ' + $executionContext.SessionState.Path.CurrentLocation + '> ' }";

export function executableOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).map(value => value.replace(/^"|"$/g, ''));
  for (const dir of dirs.filter(Boolean)) {
    const file = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
    try {
      fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch { /* Try the next fixed candidate. */ }
  }
  return null;
}

function resolveTerminalShell(shell: TerminalShell): { executable: string; args: string[] } | null {
  const win = process.platform === 'win32';
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  let executable: string | null = null;
  let args: string[] = [];
  if (shell === 'powershell') {
    executable = win ? executableOnPath('pwsh') || path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe') : executableOnPath('pwsh');
    args = ['-NoLogo', '-NoExit', '-Command', POWERSHELL_PROMPT];
  } else if (shell === 'cmd') {
    executable = win ? path.join(system32, 'cmd.exe') : null;
  } else {
    // Prefer Git Bash on Windows; System32\bash.exe is the WSL launcher and would not start in the worktree cwd.
    const git = win
      ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]
          .filter((dir): dir is string => Boolean(dir))
          .map(dir => path.join(dir, 'Git', 'bin', 'bash.exe'))
          .find(file => fs.existsSync(file))
      : undefined;
    const found = executableOnPath('bash');
    executable = git ?? (found && !(win && found.toLowerCase().startsWith(system32.toLowerCase())) ? found : null);
    args = ['--noprofile', '--norc', '-i'];
  }
  return executable && fs.existsSync(executable) ? { executable, args } : null;
}

export function resolveAgent(provider: AdeProvider, shell?: TerminalShell): { executable: string; args: string[] } | null {
  if (provider === 'terminal') {
    if (shell) return resolveTerminalShell(shell);
    return resolveTerminalShell('powershell') ?? resolveTerminalShell('bash');
  }
  const definition = PROVIDERS.find(item => item.id === provider);
  if (!definition) return null;
  if (
    provider === 'dsh' &&
    !executableOnPath('dsh') &&
    !(process.env.PATH ?? '').split(path.delimiter).some(dir => fs.existsSync(path.join(dir.replace(/^"|"$/g, ''), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')))
  ) {
    return null;
  }
  const native = executableOnPath(definition.command);
  if (native) return { executable: native, args: [] };
  if (provider === 'claude') {
    const nativeClaude = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (fs.existsSync(nativeClaude)) return { executable: nativeClaude, args: [] };
  }
  // Resolve known npm entry points directly; never run a .cmd shim or concatenate a shell command.
  if (definition.package && definition.entry) {
    const node = executableOnPath('node');
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (provider === 'claude') {
        const nativeEntry = path.join(dir.replace(/^"|"$/g, ''), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
        if (fs.existsSync(nativeEntry)) return { executable: nativeEntry, args: [] };
      }
      if (provider === 'kilo') {
        const binary = path.join(
          dir.replace(/^"|"$/g, ''),
          'node_modules',
          '@kilocode',
          'cli',
          'node_modules',
          '@kilocode',
          `cli-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}${process.arch === 'x64' ? '-baseline' : ''}`,
          'bin',
          process.platform === 'win32' ? 'kilo.exe' : 'kilo',
        );
        if (fs.existsSync(binary)) return { executable: binary, args: [] };
      }
      if ((provider === 'opencode' || provider === 'opencode2') && process.platform === 'win32') {
        const binary = path.join(dir.replace(/^"|"$/g, ''), 'node_modules', 'opencode-ai', 'bin', provider === 'opencode2' ? 'opencode2.exe' : 'opencode.exe');
        if (fs.existsSync(binary)) return { executable: binary, args: [] };
      }
      if (provider === 'opencode' || provider === 'opencode2') {
        // Current @opencode/cli exposes both command names through the same
        // native binary. Resolve the fixed package path, never execute npm shims.
        const binary = path.join(dir.replace(/^"|"$/g, ''), 'node_modules', '@opencode', 'cli', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
        try { if (fs.statSync(binary).isFile()) return { executable: binary, args: [] }; } catch { /* Try the legacy package entry. */ }
      }
      const entry = path.join(dir.replace(/^"|"$/g, ''), 'node_modules', definition.package, definition.entry);
      if (node && fs.existsSync(entry)) return { executable: node, args: [entry] };
    }
  }
  return null;
}

export function agentCatalog(): AgentCatalogResponse {
  const available = PROVIDERS.map(provider => ({
    id: provider.id,
    name: provider.name,
    command: provider.command,
    detectCmd: provider.command,
    provider: provider.id,
    installed: Boolean(resolveAgent(provider.id)),
    isDefault: provider.id === 'codex',
  }));
  const installed = available.filter(provider => provider.installed);
  return {
    runtime: 'ade',
    installed,
    available,
    defaultAgentId: installed.find(item => item.isDefault)?.id ?? installed[0]?.id ?? null,
  };
}
