import type { Alignment, DriveStep, Driver, Side } from 'driver.js';

export type ProductTourKind = 'student' | 'workspace-club' | 'workspace-coach' | 'workspace-staff' | 'coach-account';

export type ProductTourContext = {
  kind: ProductTourKind;
  userId: string;
  firstName?: string;
  businessName?: string;
};

type ProductTourStep = {
  anchor?: string;
  title: string;
  description: string;
  side?: Side;
  align?: Alignment;
};

const TOUR_VERSION = '2026-09-28.1';
const PENDING_TOUR_KEY = 'courtly:product-tour:pending';
let activeTour: Driver | null = null;
let tourGeneration = 0;

function seenKey({ kind, userId }: ProductTourContext) {
  return `courtly:product-tour:${kind}:${userId}`;
}

function storageAvailable(storage: Storage | undefined) {
  return typeof storage !== 'undefined';
}

export function markProductTourPending(userId: string) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(PENDING_TOUR_KEY, userId);
  } catch {
    // A blocked storage API should never prevent account creation.
  }
}

export function hasSeenProductTour(context: ProductTourContext, storage?: Storage) {
  if (typeof window === 'undefined' && !storage) return false;
  try {
    const target = storage ?? window.localStorage;
    return storageAvailable(target) && target.getItem(seenKey(context)) === TOUR_VERSION;
  } catch {
    return false;
  }
}

export function productTourIsPending(userId: string, storage?: Storage) {
  if (typeof window === 'undefined' && !storage) return false;
  try {
    const target = storage ?? window.sessionStorage;
    return storageAvailable(target) && target.getItem(PENDING_TOUR_KEY) === userId;
  } catch {
    return false;
  }
}

function markProductTourSeen(context: ProductTourContext) {
  try {
    window.localStorage.setItem(seenKey(context), TOUR_VERSION);
    if (window.sessionStorage.getItem(PENDING_TOUR_KEY) === context.userId) {
      window.sessionStorage.removeItem(PENDING_TOUR_KEY);
    }
  } catch {
    // The tour remains usable when storage is disabled; it simply will not persist.
  }
}

function visibleTourElement(anchor: string) {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${anchor}"]`)).find(element => {
    const bounds = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  });
}

const welcome = (title: string, description: string): ProductTourStep => ({ title, description });
const finish = (description: string): ProductTourStep => ({
  title: 'You’re ready to play',
  description,
});

export function productTourSteps({ kind, firstName, businessName }: ProductTourContext): ProductTourStep[] {
  const name = firstName?.trim() || 'there';
  if (kind === 'student') return [
    welcome(`Welcome to Courtly, ${name}`, 'Here’s a quick tour of the essentials. You can move with Back and Next, use the arrow keys, or close the tour at any time.'),
    { anchor: 'student-home', title: 'Every booking, one calm view', description: 'Home brings your sessions from every club together, with the next useful action always close by.', side: 'bottom', align: 'start' },
    { anchor: 'student-clubs', title: 'Jump back to your clubs', description: 'Your clubs appear here after you book. Choose one to head straight to its live booking page.', side: 'bottom', align: 'start' },
    { anchor: 'student-packages', title: 'Keep an eye on credits', description: 'See active class and rental credits across clubs, then open My Packages for the full detail.', side: 'bottom', align: 'start' },
    { anchor: 'student-bookings', title: 'Your sessions live here', description: 'Open a booking to see its status, payment, venue, rescheduling options, and class conversation.', side: 'top', align: 'start' },
    { anchor: 'student-navigation', title: 'Explore, book, and stay connected', description: 'Use these five destinations to discover clubs and venues, book a session, read conversations, or manage your profile.', side: 'top', align: 'center' },
    { anchor: 'student-alerts', title: 'Important changes, without the noise', description: 'The bell collects booking, payment, and reschedule updates. Its label always tells you how many are unread.', side: 'bottom', align: 'end' },
    finish('That’s the map. You can replay this tour any time from Profile under Help & support.'),
  ];

  if (kind === 'coach-account') return [
    welcome(`Welcome to Courtly, ${name}`, 'Your portable coach account is ready. This short tour shows what you can do before and after a club adds you to its roster.'),
    { anchor: 'account-profile', title: 'One profile that travels with you', description: 'Keep your public username, sports, name, and contact details current here.', side: 'bottom', align: 'start' },
    { anchor: 'account-workspaces', title: 'Your workspace access', description: 'Every coach or staff role appears here. Open a club to use the tools granted for that role.', side: 'top', align: 'start' },
    { anchor: 'account-people', title: 'Find the Courtly community', description: 'Search public profiles by name or username, or use an exact email when someone shared it with you.', side: 'top', align: 'start' },
    { anchor: 'account-rentals', title: 'Find somewhere to play', description: 'Browse available courts and training spaces even before your first club affiliation.', side: 'top', align: 'start' },
    finish('You’re set. Use “Take the tour” at the top of this page whenever you want another look.'),
  ];

  if (kind === 'workspace-staff') return [
    welcome(`Welcome to ${businessName || 'your club workspace'}`, 'This workspace is shaped by your assigned staff permissions. Courtly shows only the tools you are allowed to use.'),
    { anchor: 'workspace-home', title: 'Your role, at a glance', description: 'Home confirms which club you are working in and keeps your available tools in one place.', side: 'bottom', align: 'start' },
    { anchor: 'workspace-staff-tools', title: 'Permission-aware tools', description: 'These cards reflect your live access. If a tool is missing, the club account can review your staff permissions.', side: 'bottom', align: 'start' },
    { anchor: 'workspace-navigation', title: 'Move around with confidence', description: 'Home, Explore, Chat, and Profile stay in the same place at every screen size.', side: 'right', align: 'center' },
    finish('You’re ready. Replay this tour any time from Profile under Account & support.'),
  ];

  const coach = kind === 'workspace-coach';
  return [
    welcome(
      coach ? `Welcome to your coaching workspace, ${name}` : `Welcome to ${businessName || 'your Courtly workspace'}`,
      coach
        ? 'Here’s where your assigned schedule, students, availability, and follow-ups come together.'
        : 'Here’s a quick tour of the controls that keep your club’s classes, people, and operations moving.',
    ),
    { anchor: 'workspace-home', title: coach ? 'Your coaching day starts here' : 'Your club, at a glance', description: coach ? 'See what you are teaching today and the next action that needs you.' : 'Home turns the day’s schedule and business health into a clear starting point.', side: 'bottom', align: 'start' },
    { anchor: 'workspace-setup', title: 'Finish the foundations in order', description: coach ? 'If anything is missing, Courtly explains what the club needs to assign before you can book.' : 'Courtly guides a new club through venues, roster, classes, availability, and its first linked student.', side: 'bottom', align: 'start' },
    { anchor: 'workspace-snapshot', title: coach ? 'Your teaching pulse' : 'The numbers that matter today', description: coach ? 'Scan sessions, teaching hours, assigned students, and availability without opening a report.' : 'Sessions, collected revenue, students, and outstanding balances stay visible without becoming noisy.', side: 'bottom', align: 'start' },
    { anchor: 'workspace-agenda', title: 'Work from the agenda', description: 'Choose a date, filter by venue, and open any lesson for the full operational detail.', side: 'right', align: 'start' },
    { anchor: 'workspace-operations', title: 'See what needs attention', description: coach ? 'Acceptance, venue, attendance, and reschedule follow-ups are gathered here.' : 'Coach, venue, attendance, payment, rental, and reschedule follow-ups are gathered here.', side: 'left', align: 'start' },
    { anchor: 'workspace-navigation', title: 'Everything has a predictable home', description: 'Use Home for today, Explore for operational tools, Chat for conversations, and Profile for your account.', side: 'right', align: 'center' },
    { anchor: 'workspace-create', title: coach ? 'Book an assigned session' : 'Create without hunting', description: coach ? 'When the club setup is ready, start a booking here. Courtly protects schedule and travel conflicts.' : 'Create a booking or jump into setup from this central action.', side: 'right', align: 'center' },
    finish('That’s the working rhythm. Replay this tour any time from Profile under Account & support.'),
  ];
}

function renderedSteps(context: ProductTourContext): DriveStep[] {
  return productTourSteps(context)
    .filter(step => !step.anchor || visibleTourElement(step.anchor))
    .map(step => ({
      ...(step.anchor ? { element: () => visibleTourElement(step.anchor!) as Element } : {}),
      skipMissingElement: true,
      popover: {
        title: step.title,
        description: step.description,
        side: step.side ?? 'bottom',
        align: step.align ?? 'center',
      },
    }));
}

export async function startProductTour(context: ProductTourContext, options: { force?: boolean } = {}) {
  if (typeof window === 'undefined') return false;
  const force = options.force === true;
  if (!force && (!productTourIsPending(context.userId) || hasSeenProductTour(context))) return false;

  const generation = ++tourGeneration;
  activeTour?.destroy();
  const steps = renderedSteps(context);
  const { driver } = await import('driver.js');
  if (generation !== tourGeneration) return false;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tour = driver({
    steps,
    animate: !reduceMotion,
    smoothScroll: !reduceMotion,
    allowClose: true,
    allowKeyboardControl: true,
    overlayClickBehavior: 'close',
    overlayColor: '#102c22',
    overlayOpacity: 0.62,
    stagePadding: 8,
    stageRadius: 14,
    popoverOffset: 12,
    popoverClass: 'courtly-tour',
    showButtons: ['previous', 'next', 'close'],
    showProgress: true,
    progressText: 'Step {{current}} of {{total}}',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Finish',
    skipMissingElement: true,
    waitForElement: 250,
    onPopoverRender: popover => {
      popover.wrapper.setAttribute('aria-modal', 'true');
      popover.title.setAttribute('role', 'heading');
      popover.title.setAttribute('aria-level', '2');
      popover.closeButton.setAttribute('aria-label', 'Close product tour');
      popover.progress.setAttribute('aria-live', 'polite');
      window.requestAnimationFrame(() => popover.nextButton.focus());
    },
    onDestroyed: () => {
      if (activeTour === tour) activeTour = null;
    },
  });

  activeTour = tour;
  markProductTourSeen(context);
  tour.drive();
  return true;
}

export function destroyProductTour() {
  tourGeneration += 1;
  activeTour?.destroy();
  activeTour = null;
}

export const productTourStorage = { pendingKey: PENDING_TOUR_KEY, version: TOUR_VERSION };
