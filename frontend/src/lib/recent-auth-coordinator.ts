type RecentAuthHandler = () => Promise<void>;

let handler: RecentAuthHandler | null = null;
let inFlight: Promise<void> | null = null;

/**
 * Registers the single app-shell prompt used when the API requires a fresh
 * credential check. Keeping the coordinator outside React lets every API
 * helper, including downloads, share one prompt and one in-flight result.
 */
export function registerRecentAuthHandler(next: RecentAuthHandler) {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/** Returns false when no browser prompt is mounted (for example during SSR). */
export async function requestRecentAuthentication() {
  if (!handler) return false;
  if (!inFlight) {
    inFlight = handler().finally(() => { inFlight = null; });
  }
  await inFlight;
  return true;
}
