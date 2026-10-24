import { CliError } from './cli.js';

export function validateGhEndpoint(endpoint: string): void {
  const paged = endpoint.match(/^(.*)&page=([1-9][0-9]{0,4})$/);
  if (paged && !paged[1].includes('&page=') && Number(paged[2]) <= 10000) {
    validateGhEndpoint(paged[1]);
    return;
  }

  const commitsNoSha = endpoint.match(/^repos\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/commits\?per_page=20$/);
  if (commitsNoSha) return;

  const commitsSha = endpoint.match(
    /^repos\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/commits\?per_page=20&sha=([^&]+)$/
  );
  if (commitsSha) {
    const rawSha = commitsSha[3];
    try {
      const decoded = decodeURIComponent(rawSha);
      if (
        decoded.length > 0 &&
        decoded.length <= 256 &&
        !/[\x00-\x1F\x7F]/.test(decoded) &&
        encodeURIComponent(decoded) === rawSha
      ) {
        return;
      }
    } catch {}
  }

  const pullsNoHead = endpoint.match(
    /^repos\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/pulls\?state=all&sort=updated&direction=desc&per_page=20$/
  );
  if (pullsNoHead) return;

  const pullsHead = endpoint.match(
    /^repos\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/pulls\?state=all&sort=updated&direction=desc&per_page=20&head=([^&]+)$/
  );
  if (pullsHead) {
    const rawHead = pullsHead[3];
    try {
      const decoded = decodeURIComponent(rawHead);
      if (
        decoded.length > 0 &&
        decoded.length <= 256 &&
        !/[\x00-\x1F\x7F]/.test(decoded) &&
        encodeURIComponent(decoded) === rawHead
      ) {
        return;
      }
    } catch {}
  }

  const issuesPattern = endpoint.match(
    /^repos\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/issues\?state=all&sort=updated&direction=desc&per_page=20$/
  );
  if (issuesPattern) return;

  throw new CliError('INVALID_ARGUMENT', `GitHub endpoint pattern not allowed: ${endpoint}`);
}
