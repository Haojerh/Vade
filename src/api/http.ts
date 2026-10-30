import type { ApiError, MessageAttachment } from '../../shared/contracts';

/**
 * Strips ANSI escape sequences and non-printable control characters from text.
 */
export function stripAnsi(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1B\\))/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

export async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let errorMessage = `HTTP ${res.status} ${res.statusText}`;
    try {
      const cloned = res.clone();
      try {
        const errorJson = (await res.json()) as ApiError;
        if (errorJson?.error?.message) {
          errorMessage = `[${errorJson.error.code}] ${errorJson.error.message}`;
        }
      } catch {
        const text = await cloned.text();
        if (text && text.trim()) {
          errorMessage = `${errorMessage}: ${text.trim().slice(0, 200)}`;
        }
      }
    } catch {
      // Body not readable, retain default status message
    }
    throw new Error(errorMessage);
  }
  return res.json() as Promise<T>;
}

export async function encodeMessageFiles(files: File[]): Promise<MessageAttachment[]> {
  return Promise.all(files.map(async (file) => ({
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    dataBase64: await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error(`Cannot read ${file.name}`));
      reader.readAsDataURL(file);
    }),
  })));
}
