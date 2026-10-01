/**
 * The guardian "Viewing as" switcher. A child view is a read-only projection
 * the adult opens for a linked child; it is never a session as the child. The
 * URL carries only the child's ID, and it means something only when that ID is
 * among the children the server says this adult may view right now.
 */

export const SELF_PLAYER = 'self';

/** Tabs that can show a child's training; every other tab is the adult's own. */
export const playerTabs = ['home', 'progress'] as const;
export type PlayerTab = typeof playerTabs[number];

export function isPlayerTab(tab: string): tab is PlayerTab {
  return (playerTabs as readonly string[]).includes(tab);
}

export type PlayerResolution<T> =
  | { status: 'self' }
  | { status: 'loading' }
  | { status: 'child'; child: T }
  | { status: 'invalid' };

export function resolvePlayer<T extends { id: string }>(
  requested: string | null | undefined,
  children: readonly T[] | null,
  tab: string,
): PlayerResolution<T> {
  const id = requested?.trim();
  if (!id || id === SELF_PLAYER || !isPlayerTab(tab)) return { status: 'self' };
  if (children === null) return { status: 'loading' };
  const child = children.find(candidate => candidate.id === id);
  return child ? { status: 'child', child } : { status: 'invalid' };
}

/** Build a /manage link that keeps the club slug and, where it applies, the player. */
export function manageHref(tab: string, options: { slug?: string; player?: string | null } = {}) {
  const params = new URLSearchParams();
  if (options.slug) params.set('slug', options.slug);
  params.set('tab', tab);
  if (options.player && options.player !== SELF_PLAYER && isPlayerTab(tab)) params.set('player', options.player);
  return `/manage?${params.toString()}`;
}

/** Match "New coach feedback for Mia" to a linked child without trusting it as authority. */
export function childNamedIn<T extends { displayName: string }>(text: string, children: readonly T[]) {
  const value = text.toLowerCase();
  return [...children]
    .sort((a, b) => b.displayName.length - a.displayName.length)
    .find(child => child.displayName.trim() && value.includes(child.displayName.trim().toLowerCase())) ?? null;
}
