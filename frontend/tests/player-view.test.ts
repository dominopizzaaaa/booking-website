import { describe, expect, it } from 'vitest';
import { childNamedIn, isPlayerTab, manageHref, resolvePlayer, SELF_PLAYER } from '../src/lib/player-view';
import { attendanceLabel } from '../src/lib/student-bookings';

const children = [
  { id: 'child-1', displayName: 'Mia', username: 'mia_tan' },
  { id: 'child-2', displayName: 'Mia Rose', username: 'mia_rose' },
];

describe('guardian player view', () => {
  it('shows the adult unless a listed child is requested on a player tab', () => {
    expect(resolvePlayer(null, children, 'home')).toEqual({ status: 'self' });
    expect(resolvePlayer(SELF_PLAYER, children, 'home')).toEqual({ status: 'self' });
    expect(resolvePlayer('child-1', children, 'explore')).toEqual({ status: 'self' });
    expect(resolvePlayer('child-1', children, 'progress')).toEqual({ status: 'child', child: children[0] });
  });

  it('waits for the server list and refuses IDs it does not contain', () => {
    expect(resolvePlayer('child-1', null, 'home')).toEqual({ status: 'loading' });
    expect(resolvePlayer('someone-else', children, 'home')).toEqual({ status: 'invalid' });
    expect(resolvePlayer('child-1', [], 'home')).toEqual({ status: 'invalid' });
  });

  it('keeps the player only on tabs that can show a child', () => {
    expect(isPlayerTab('home')).toBe(true);
    expect(isPlayerTab('chat')).toBe(false);
    expect(manageHref('home', { slug: 'riverside', player: 'child-1' })).toBe('/manage?slug=riverside&tab=home&player=child-1');
    expect(manageHref('book', { player: 'child-1' })).toBe('/manage?tab=book');
    expect(manageHref('progress', { player: SELF_PLAYER })).toBe('/manage?tab=progress');
  });

  it('matches an alert to the most specific child name', () => {
    expect(childNamedIn('New coach feedback for Mia Rose', children)?.id).toBe('child-2');
    expect(childNamedIn('New coach feedback for Mia', children)?.id).toBe('child-1');
    expect(childNamedIn('New coach feedback', children)).toBeNull();
  });

  it('describes attendance without implying more than was recorded', () => {
    expect(attendanceLabel('PRESENT')).toBe('Attended');
    expect(attendanceLabel('LATE')).toBe('Attended (arrived late)');
    expect(attendanceLabel('UNMARKED')).toBe('');
  });
});
