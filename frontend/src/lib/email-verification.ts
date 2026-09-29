export type VerificationLocation = { hash: string; pathname: string; search: string };
let pendingFragmentToken: string | null = null;

/**
 * Read and remove the fragment-only bearer synchronously during the first
 * client render. Fragments do not reach the server, and scrubbing before an
 * effect runs keeps the bearer out of later navigation history and diagnostics.
 */
export function consumeVerificationToken(
  location: VerificationLocation,
  replaceState: (data: unknown, unused: string, url?: string | URL | null) => void,
  historyState: unknown = null,
) {
  const token = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash)
    .get('token')?.trim() || '';
  if (location.hash) replaceState(historyState, '', `${location.pathname}${location.search}`);
  return token;
}

export function consumeWindowVerificationToken() {
  if (typeof window === 'undefined') return '';
  const token = consumeVerificationToken(
    window.location, window.history.replaceState.bind(window.history), window.history.state,
  );
  // React development checks may initialize component state twice. Retain the
  // already-scrubbed value until the verification effect captures it.
  if (token) pendingFragmentToken = token;
  return token || pendingFragmentToken || '';
}

export function releaseWindowVerificationToken(token: string) {
  if (pendingFragmentToken === token) pendingFragmentToken = null;
}
