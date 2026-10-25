export function phoneOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 253) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(url.hostname) && !url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}
