import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { detectScheduleDraft, type ScheduleMessage, type ScheduleVenue } from '../src/chat-schedule-detect.js';

const zone = 'Asia/Singapore';
// Friday 2 October 2026, 18:00 in Singapore unless a test says otherwise.
const friday = DateTime.fromISO('2026-10-02T18:00', { zone });

type Line = string | { body: string; at?: DateTime; kind?: string };

function conversation(lines: Line[], start = friday) {
  return lines.map((line, index): ScheduleMessage => {
    const entry = typeof line === 'string' ? { body: line } : line;
    return {
      id: `m${index + 1}`,
      kind: entry.kind ?? 'TEXT',
      body: entry.body,
      createdAt: (entry.at ?? start.plus({ minutes: index })).toJSDate(),
    };
  });
}

function detect(lines: Line[], options: { start?: DateTime; venues?: ScheduleVenue[]; now?: DateTime } = {}) {
  const start = options.start ?? friday;
  const messages = conversation(lines, start);
  const now = options.now ?? DateTime.fromJSDate(messages.at(-1)!.createdAt, { zone }).plus({ minutes: 1 });
  return detectScheduleDraft(messages, { timezone: zone, venues: options.venues, now: now.toJSDate() });
}

const clock = (minutes: number | null) => minutes === null ? null
  : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

function summary(lines: Line[], options: Parameters<typeof detect>[1] = {}) {
  const draft = detect(lines, options);
  return draft && {
    date: draft.date,
    start: clock(draft.startMinutes),
    end: clock(draft.endMinutes),
    locationId: draft.locationId,
    source: draft.sourceMessageId,
  };
}

describe('chat schedule detection', () => {
  it('follows the coach offer and the student counter in the reference conversation', () => {
    const lateNight = DateTime.fromISO('2026-10-03T01:17', { zone });
    const offer = { body: 'Do you want to have a session tomorrow 9am-1030am?', at: lateNight };
    const counter = { body: 'Can shift to 12pm? i got stuff at 10am', at: lateNight.plus({ minutes: 4 }) };

    // Sent at 1:17am, "tomorrow" is the day that has already started.
    expect(summary(['hello', offer], { now: lateNight.plus({ minutes: 1 }) })).toEqual({
      date: '2026-10-03', start: '09:00', end: '10:30', locationId: null, source: 'm2',
    });
    // The counter keeps the date and 90-minute length and ignores the busy 10am.
    expect(summary(['hello', offer, counter], { now: lateNight.plus({ minutes: 5 }) })).toEqual({
      date: '2026-10-03', start: '12:00', end: '13:30', locationId: null, source: 'm3',
    });
  });

  it('reads "tomorrow" literally once the night is over', () => {
    const morning = DateTime.fromISO('2026-10-03T08:00', { zone });
    expect(summary(['session tomorrow 9am-1030am?'], { start: morning })?.date).toBe('2026-10-04');
    const justBeforeFour = DateTime.fromISO('2026-10-03T03:59', { zone });
    expect(summary(['tmr 9am?'], { start: justBeforeFour })?.date).toBe('2026-10-03');
  });

  it('picks am or pm the way a coach would', () => {
    const cases: Array<[string, string]> = [
      ['tmr at 12?', '12:00'],
      ['tmr at 3?', '15:00'],
      ['tmr at 9?', '09:00'],
      ['tmr 11 can?', '11:00'],
      ['tmr at 6', '18:00'],
      ['tmr morning 8?', '08:00'],
      ['tmr evening 8?', '20:00'],
      ['tomorrow night at 9', '21:00'],
      ['tmr 12nn', '12:00'],
      ['tmr noon', '12:00'],
      ['tmr 1530hrs', '15:30'],
      ['tmr 0930', '09:30'],
      ['tmr 7.30pm', '19:30'],
      ['tmr half past 4', '16:30'],
      ['tmr quarter to 5', '16:45'],
    ];
    for (const [body, start] of cases) expect(summary([body])?.start, body).toBe(start);
  });

  it('anchors a bare counter time to the time already being discussed', () => {
    expect(summary(['sat 7pm?', 'can do 8?'])?.start).toBe('20:00');
    expect(summary(['sat 9am?', 'can do 8?'])?.start).toBe('08:00');
    expect(summary(['sat 9am?', 'how about 2?'])?.start).toBe('14:00');
  });

  it('prefers a time still ahead today when nobody named a day', () => {
    const afternoon = DateTime.fromISO('2026-10-02T14:00', { zone });
    expect(summary(['can do 8?'], { start: afternoon })).toMatchObject({ date: '2026-10-02', start: '20:00' });
    // 11am has passed, so a bare "11am" means tomorrow.
    expect(summary(['11am?'], { start: afternoon })).toMatchObject({ date: '2026-10-03', start: '11:00' });
  });

  it('understands time ranges with a shared or implied suffix', () => {
    expect(summary(['sat 11-1pm'])).toMatchObject({ start: '11:00', end: '13:00' });
    expect(summary(['sat 10-12pm'])).toMatchObject({ start: '10:00', end: '12:00' });
    expect(summary(['sat 2-4pm'])).toMatchObject({ start: '14:00', end: '16:00' });
    expect(summary(['sat from 9 to 10.30'])).toMatchObject({ start: '09:00', end: '10:30' });
    expect(summary(['sat 3 till 5'])).toMatchObject({ start: '15:00', end: '17:00' });
    expect(summary(['sat 9am – 10:30am'])).toMatchObject({ start: '09:00', end: '10:30' });
  });

  it('keeps a stated length when the start moves and accepts lengths on their own', () => {
    expect(summary(['sun 4pm for 1.5 hours', 'make it 5 instead'])).toMatchObject({ start: '17:00', end: '18:30' });
    expect(summary(['sun 4pm', '2 hrs ok?'])).toMatchObject({ start: '16:00', end: '18:00' });
    expect(summary(['sun 4pm', 'an hour and a half pls'])).toMatchObject({ end: '17:30' });
    expect(summary(['sun 4pm', '1h30'])).toMatchObject({ end: '17:30' });
    expect(summary(['sun 4pm', '45 mins enough'])).toMatchObject({ end: '16:45' });
    expect(summary(['sun 4pm'])).toMatchObject({ start: '16:00', end: null });
  });

  it('moves the session by a relative amount', () => {
    expect(summary(['sun 4-5pm', 'can push back 30 mins?'])).toMatchObject({ start: '16:30', end: '17:30' });
    expect(summary(['sun 4-5pm', 'one hour later can?'])).toMatchObject({ start: '17:00', end: '18:00' });
    expect(summary(['sun 4-5pm', 'bring it forward by 1h'])).toMatchObject({ start: '15:00', end: '16:00' });
  });

  it('reads weekdays, explicit dates and next week', () => {
    // Friday 2 Oct: "sat" is tomorrow, and the coming Monday already falls in
    // next week, so "next mon" is 5 Oct while "fri" is a week away.
    expect(summary(['sat 9am'])?.date).toBe('2026-10-03');
    expect(summary(['this sun 9am'])?.date).toBe('2026-10-04');
    expect(summary(['next mon 9am'])?.date).toBe('2026-10-05');
    expect(summary(['fri 9am'])?.date).toBe('2026-10-09');
    expect(summary(['wed next week 9am'])?.date).toBe('2026-10-07');
    expect(summary(['10 oct 9am'])?.date).toBe('2026-10-10');
    expect(summary(['oct 10th at 9'])?.date).toBe('2026-10-10');
    expect(summary(['12/10 at 3'])?.date).toBe('2026-10-12');
    expect(summary(['on the 15th at 3pm'])?.date).toBe('2026-10-15');
    expect(summary(['this weekend 10am'])?.date).toBe('2026-10-03');
    expect(summary(['day after tmr 9am'])?.date).toBe('2026-10-04');
    expect(summary(['sat 9am', 'same time next week?'])?.date).toBe('2026-10-10');
  });

  it('lets a later message change only the date', () => {
    expect(summary(['tmr 9am-1030am', 'can we do sun instead?'])).toMatchObject({
      date: '2026-10-04', start: '09:00', end: '10:30',
    });
  });

  it('waits for a new date when the current one is turned down', () => {
    expect(summary(['tmr 9am?', "can't tmr"])).toBeNull();
    expect(summary(['tmr 9am?', "can't tmr", 'sun?'])).toMatchObject({ date: '2026-10-04', start: '09:00' });
    expect(summary(['tmr 9am?', 'not 9, 11?'])).toMatchObject({ date: '2026-10-03', start: '11:00' });
    expect(summary(['tmr 9am?', "can't do 9 how about 11"])).toMatchObject({ start: '11:00' });
  });

  it('drops the plan on a refusal or cancellation', () => {
    expect(summary(['tmr 9am?', "sorry I can't make it"])).toBeNull();
    expect(summary(['tmr 9am?', 'never mind, cancel'])).toBeNull();
    expect(summary(['tmr 9am?', 'busy'])).toBeNull();
  });

  it('ignores numbers that are not times', () => {
    expect(summary(['I have 2 rackets'])).toBeNull();
    expect(summary(['bring 3 shuttles tmr'])).toBeNull();
    expect(summary(['the class is $80 for 1 hour'])).toBeNull();
    expect(summary(['we play on court 3 tmr'])).toBeNull();
    expect(summary(['my number is 9123 4567'])).toBeNull();
    expect(summary(['u12 team tmr'])).toBeNull();
    expect(summary(['how are you'])).toBeNull();
    expect(summary(['I scored 21 points tmr'])).toBeNull();
  });

  it('does not read travel or lateness as the session length', () => {
    expect(summary(['sun 4-5pm', "I'll be 10 mins late"])).toMatchObject({ start: '16:00', end: '17:00' });
    expect(summary(['sun 4-5pm', 'its a 30 min drive for me'])).toMatchObject({ start: '16:00', end: '17:00' });
    expect(summary(['sun 4-5pm', 'come 15 mins before to warm up'])).toMatchObject({ start: '16:00', end: '17:00' });
  });

  it('keeps the first of several offered times', () => {
    expect(summary(['tmr 9 or 10?'])).toMatchObject({ start: '09:00' });
    expect(summary(['tmr 9am? or 10am also can'])).toMatchObject({ start: '09:00' });
  });

  it('treats a lone number reply as a time', () => {
    expect(summary(['tmr?', '10?'])).toMatchObject({ date: '2026-10-03', start: '10:00' });
    expect(summary(['sat', '4 can'])).toMatchObject({ date: '2026-10-03', start: '16:00' });
  });

  it('takes the proposed time over a mentioned commitment', () => {
    expect(summary(["I'm free after my school at 3, so 4pm sat?"])).toMatchObject({ start: '16:00' });
    expect(summary(['can we have class at 3 on sat?'])).toMatchObject({ start: '15:00' });
  });

  it('matches a mentioned venue to the bookable venues only', () => {
    const venues = [
      { id: 'bishan', name: 'Bishan Sports Hall', address: '5 Bishan Street 14' },
      { id: 'toa', name: 'Toa Payoh Sports Hall', address: '297 Lorong 6 Toa Payoh' },
      { id: 'clementi', name: 'Clementi Court', address: null },
    ];
    expect(summary(['sat 9am at bishan?'], { venues })?.locationId).toBe('bishan');
    expect(summary(['sat 9am', 'toa payoh better'], { venues })?.locationId).toBe('toa');
    expect(summary(['sat 9am at Clementi Court'], { venues })?.locationId).toBe('clementi');
    expect(summary(['sat 9am at the sports hall'], { venues })?.locationId).toBeNull();
    expect(summary(['sat 9am at jurong'], { venues })?.locationId).toBeNull();
  });

  it('starts over after a proposal card and ignores system lines', () => {
    expect(summary(['tmr 9am?', { body: 'Coach proposed the next session', kind: 'PROPOSAL' }])).toBeNull();
    expect(summary([
      'tmr 9am?', { body: 'proposed', kind: 'PROPOSAL' }, 'ok and sun 4pm also?',
    ])).toMatchObject({ date: '2026-10-04', start: '16:00' });
    expect(summary(['tmr 9am?', { body: 'Reminder: session tomorrow at 3pm', kind: 'SYSTEM' }])).toMatchObject({ start: '09:00' });
  });

  it('never suggests a time that has already passed', () => {
    expect(summary(['today 9am?'], { start: DateTime.fromISO('2026-10-02T10:00', { zone }) })).toBeNull();
    expect(summary(['tmr 9am?'], { now: DateTime.fromISO('2026-10-03T09:30', { zone }) })).toBeNull();
  });
});
