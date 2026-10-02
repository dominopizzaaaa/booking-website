import { DateTime } from 'luxon';

/**
 * Reads a conversation for a session two people are arranging, so the chat
 * can offer to turn it into a real proposal. It only ever suggests: nothing is
 * proposed or booked until someone presses the button, and the proposal flow
 * re-validates everything. Pure and synchronous so every rule is unit-tested
 * without a database.
 *
 * The conversation is replayed in order into one running draft. A later
 * message edits the draft rather than replacing it, so "can shift to 12pm?"
 * keeps the date and length that an earlier "tomorrow 9am-1030am" set.
 */

export type ScheduleMessage = { id: string; kind: string; body: string; createdAt: Date };
export type ScheduleVenue = { id: string; name: string; address?: string | null };
export type ScheduleDraft = {
  /** Local calendar date, yyyy-MM-dd, in the conversation's timezone. */
  date: string;
  /** Minutes after local midnight. */
  startMinutes: number;
  /** Null when nobody has said how long the session runs. */
  endMinutes: number | null;
  durationMinutes: number | null;
  locationId: string | null;
  startAt: Date;
  /** The latest message that changed the draft. */
  sourceMessageId: string;
};

type Draft = {
  date: string | null;
  /** Someone turned the date down; wait for a new one instead of guessing. */
  dateRejected: boolean;
  start: number | null;
  duration: number | null;
  locationId: string | null;
  /** When the start was set, to infer a date nobody stated. */
  timeSetAt: DateTime | null;
  sourceMessageId: string;
};

type TimeToken = {
  index: number;
  end: number;
  hour: number;
  minute: number;
  suffix: string | null;
  /** Written unambiguously as a time: a colon, a suffix, or 24-hour form. */
  explicit: boolean;
};

type ParsedTime = { start: number; end: number | null; score: number };

type Parsed = {
  date: string | null;
  busyDates: string[];
  nextWeek: boolean;
  time: ParsedTime | null;
  busyTimes: number[];
  duration: number | null;
  shift: number | null;
  cancel: boolean;
  negative: boolean;
  locationId: string | null;
};

const MINUTES_PER_DAY = 24 * 60;
const MIN_SESSION = 15;
const MAX_SESSION = 6 * 60;
/** A start outside this window needs an explicit am/pm to be believed. */
const EARLIEST_PLAUSIBLE = 6 * 60;
const LATEST_PLAUSIBLE = 23 * 60;
/** Before this hour, people still mean the previous evening's "tomorrow". */
const LATE_NIGHT_HOUR = 4;

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

const WEEKDAYS: Record<string, number> = {
  mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6, sun: 7, sunday: 7,
};
const WEEKDAY = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join('|');

const TOMORROW = String.raw`tomorrow|tmrw|tmr|tml|tmw|tmoro|tomoro|tomorow|tomolo|tomo|2moro|2morrow|2mrw|2mr`;
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4 };

// "Busy" language marks the times and dates in its clause as ones a person
// cannot do, so "can shift to 12pm? i got stuff at 10am" proposes 12 and
// treats 10 as the reason. A modal before "we have" ("can we have class at
// 3?") is a request, not a conflict.
const BUSY = new RegExp([
  String.raw`\bbusy\b`, String.raw`\bnot (?:free|available|ok|okay|possible)\b`, String.raw`\bunavailable\b`,
  String.raw`\boccupied\b`, String.raw`\btied up\b`, String.raw`\bno time\b`,
  String.raw`\b(?:can't|cant|cannot|can not|unable to|won't be able|wont be able|couldn't|couldnt)\b`,
  String.raw`\bgot (?:stuff|something|sth|smth|school|class|work|exam|exams|tuition|plans|cca|church|a meeting|meeting|an appointment|appointment)\b`,
  String.raw`(?<!\b(?:can|could|shall|should|will|would|to)\s)\b(?:i|we)(?:'ve| have| has)? (?:have|got|has) (?:stuff|something|sth|smth|school|class|work|an exam|exam|exams|tuition|plans|cca|church|a meeting|meeting|an appointment|appointment|lunch|dinner)\b`,
  String.raw`\bmy (?:school|work|exam|exams|tuition|meeting|appointment|lecture|cca)\b`,
].join('|'));
const CANCEL = /\b(?:cancel|cancelled|canceled|call it off|never ?mind|nvm|forget it|forget about it)\b/;
const NOT_THIS_TIME = /\b(?:instead of|rather than|not|except|other than|no longer)\s*(?:at\s*)?$/;
const STRONG_CUE = /\b(?:shift|shifted|move|moved|change|changed|push|pushed|make it|how about|what about|hows about|how bout|can do|could do|can make|free at|free from|free after|ok|okay|let's do|lets do|let's|lets|instead|switch|switched|rather|prefer|go with|start at)\b/;
const BARE_CUE = /(?:\b(?:at|around|abt|about|from|after|by|to|till|til|until|before|make it|how about|what about|hows|or|ok|okay|can|do|say|like|then|start|starting|instead|also|maybe|either|today|tonight|tonite|morning|afternoon|evening|night|noon)|@|(?:\b(?:this|coming|next) )?\b(?:mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday|tomorrow|tmrw|tmr|tml|tmw|tmoro|tomoro|tomorow|tomolo|tomo|2moro|2morrow|2mrw|2mr|weekend))\s*$/;
const BARE_FOLLOWER = /^\s?(?:ish\b|o'?clock\b|onwards?\b|can\b|ok\b|okay\b|\?|start\b|sharp\b)/;
const FILLER_ONLY = /^(?:\s|\?|ok|okay|can|sure|maybe|or|then|lah|lor|leh|ah|ya|yeah|yes|yep|pls|please|ba|bah|hor|anot|or not|is it|right)*$/;
const UNIT_AFTER = /^\s?(?:%|x\b|k\b|km\b|kg\b|m\b|min|mins|minute|minutes|hr|hrs|hour|hours|h\b|days?|weeks?|wks?|months?|years?|yrs?|yo\b|people|ppl|pax|persons?|players?|students?|kids?|children|friends?|others|times|sessions?|lessons?|classes|rackets?|racquets?|balls?|courts?|shuttles?|tubes?|sets?|games?|points?|dollars?|bucks|sgd|cents?|plus\b|\+|th\b|st\b|nd\b|rd\b|\/)/;
const UNIT_BEFORE = /(?:\$|s\$|sgd|\bcourt|\bct|\blvl|\blevel|\broom|\bhall|\bno\.?|\bnumber|#|\bu|\bunder|\bage|\baged|\bblk|\bblock|\bunit|\bbus|\bpage|\bgrade|\btop|\brank|\branked|\bsec|\bprimary|\bp|\bjc|\byear|\byr|\bx)\s*$/;
const RANGE_JOINER = /^\s*(?:-|~|to|till|til|until)\s*$/;
const NOT_SESSION_LENGTH = /^\s*(?:late|early|away|ago|left|more|drive|walk|ride|commute|journey|travel|by (?:car|bus|train|mrt|cab|grab)|on (?:the )?(?:bus|train|mrt|way)|of (?:warm|drive|walk|travel|break|rest)|warm|break|rest|before|after|in advance|beforehand)\b/;
const AM_CONTEXT = /\b(?:morning|mornings|breakfast|early)\b/;
const PM_CONTEXT = /\b(?:afternoon|evening|tonight|tonite|2nite|night|after school|after work|dinner|arvo|lunch)\b/;

const VENUE_STOPWORDS = new Set([
  'court', 'courts', 'hall', 'halls', 'centre', 'center', 'sports', 'sport', 'club', 'academy', 'badminton', 'tennis',
  'squash', 'pickleball', 'padel', 'table', 'complex', 'stadium', 'school', 'park', 'arena', 'ground', 'grounds',
  'field', 'indoor', 'outdoor', 'main', 'venue', 'location', 'singapore', 'community', 'street', 'road', 'avenue',
  'drive', 'block', 'level', 'floor', 'building', 'place', 'there', 'here', 'with', 'from', 'that', 'this', 'the',
]);

function normalize(text: string) {
  return text.toLowerCase()
    .replace(/[‘’ʼ`]/g, '\'')
    .replace(/[‐-―−]/g, '-')
    .replace(/\b([ap])\.\s?m\b\.?/g, '$1m')
    .replace(/\b(\d{1,2})\s?noon\b/g, '$1nn')
    .replace(/\bmid-?day\b|\bnoon\b/g, '12nn')
    .replace(/\bhalf past (\d{1,2})\b/g, '$1:30')
    .replace(/\bquarter past (\d{1,2})\b/g, '$1:15')
    .replace(/\bquarter to (\d{1,2})\b/g, (_, hour: string) => `${(Number(hour) + 11) % 12 || 12}:45`)
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Split at sentence ends, commas and the words that start an alternative,
 * so busy language only affects the clause it belongs to.
 */
function clauses(text: string) {
  return text
    .split(/[!?;\n]+|\.(?=\s|$)|,|\s(?=(?:but|because|cos|coz|cuz|how about|what about|hows about|or|instead|maybe|alternatively|otherwise|if not|then)\b)/)
    .map(part => part.trim())
    .filter(Boolean);
}

/** Blank a matched span so later passes cannot re-read its digits. */
function blank(text: string, index: number, length: number) {
  return text.slice(0, index) + ' '.repeat(length) + text.slice(index + length);
}

function humanDay(at: DateTime) {
  // At 1am, "tomorrow" and "Saturday" still mean what they meant at 11pm.
  return (at.hour < LATE_NIGHT_HOUR ? at.minus({ days: 1 }) : at).startOf('day');
}

function nextOnOrAfter(base: DateTime, date: DateTime) {
  return date < base ? date.plus({ years: 1 }) : date;
}

function weekdayDate(at: DateTime, weekday: number, qualifier: string | undefined, nextWeek: boolean) {
  const base = humanDay(at);
  if (nextWeek) return base.startOf('week').plus({ weeks: 1, days: weekday - 1 });
  let ahead = (weekday - base.weekday + 7) % 7;
  if (ahead === 0 && qualifier !== 'this') ahead = 7;
  if ((qualifier === 'next' || qualifier === 'nxt') && base.weekday + ahead <= 7) ahead += 7;
  return base.plus({ days: ahead });
}

type DateHit = { date: string; index: number };

function extractDates(input: string, at: DateTime) {
  let text = input;
  const hits: DateHit[] = [];
  let nextWeek = false;
  const take = (regex: RegExp, resolve: (match: RegExpExecArray) => DateTime | null) => {
    for (const match of [...text.matchAll(regex)]) {
      const date = resolve(match);
      text = blank(text, match.index!, match[0].length);
      if (date?.isValid) hits.push({ date: date.toISODate()!, index: match.index! });
    }
  };
  const today = at.startOf('day');
  const base = humanDay(at);
  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, match => DateTime.fromObject(
    { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }, { zone: at.zone },
  ));
  take(new RegExp(String.raw`\b(?:the )?day after (?:${TOMORROW})\b|\bovermorrow\b`, 'g'), () => base.plus({ days: 2 }));
  take(new RegExp(String.raw`\b(?:${TOMORROW})\b`, 'g'), () => base.plus({ days: 1 }));
  take(/\b(?:later today|today|tdy|tday|2day|tonight|tonite|2nite|this (?:morning|afternoon|evening))\b/g, () => today);
  take(new RegExp(String.raw`\b(?:(this|coming|next|nxt|the) )?(${WEEKDAY})\b(?:,? (next week|this week))?`, 'g'), match => {
    if (match[1] === 'the' && match[2] === 'sun') return null;
    return weekdayDate(at, WEEKDAYS[match[2]], match[1], match[3] === 'next week');
  });
  take(new RegExp(String.raw`\bnext week,? (${WEEKDAY})\b`, 'g'), match => weekdayDate(at, WEEKDAYS[match[1]], undefined, true));
  take(/\b(?:(this|coming|next|the) )?weekend\b/g, match => weekdayDate(at, 6, match[1] === 'next' ? 'next' : 'this', false));
  take(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)? (?:of )?(${MONTH})\b(?: (\d{4}))?`, 'g'), match => {
    const date = DateTime.fromObject({ year: Number(match[3] ?? today.year), month: MONTHS[match[2]], day: Number(match[1]) }, { zone: at.zone });
    return match[3] ? date : nextOnOrAfter(base, date);
  });
  take(new RegExp(String.raw`\b(${MONTH}) (\d{1,2})(?:st|nd|rd|th)?\b(?!\s?(?:am|pm|nn|[:.]\d))`, 'g'), match => {
    // "may" is usually a verb; only "May 3" style dates count.
    const date = DateTime.fromObject({ year: today.year, month: MONTHS[match[1]], day: Number(match[2]) }, { zone: at.zone });
    return nextOnOrAfter(base, date);
  });
  // Singapore writes day before month.
  take(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/g, match => {
    const year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : today.year;
    const date = DateTime.fromObject({ year, month: Number(match[2]), day: Number(match[1]) }, { zone: at.zone });
    return match[3] ? date : nextOnOrAfter(base, date);
  });
  take(/\b(?:on )?the (\d{1,2})(?:st|nd|rd|th)\b|\bon (\d{1,2})(?:st|nd|rd|th)\b/g, match => {
    const day = Number(match[1] ?? match[2]);
    const date = base.set({ day });
    if (!date.isValid || date.day !== day) return null;
    return date < base ? base.plus({ months: 1 }).set({ day }) : date;
  });
  text = text.replace(/\bnext week\b/g, found => { nextWeek = true; return ' '.repeat(found.length); });
  hits.sort((a, b) => a.index - b.index);
  return { text, dates: hits.map(hit => hit.date), nextWeek };
}

type DurationHit = { minutes: number; index: number; end: number };

function numberValue(raw: string) {
  return NUMBER_WORDS[raw] ?? Number(raw);
}

function extractDurations(input: string) {
  let text = input;
  const hits: DurationHit[] = [];
  const take = (regex: RegExp, minutes: (match: RegExpExecArray) => number) => {
    for (const match of [...text.matchAll(regex)]) {
      const value = minutes(match);
      const end = match.index! + match[0].length;
      text = blank(text, match.index!, match[0].length);
      // "10 mins late", "30 min drive" and "5 mins away" describe travel,
      // not the session, and must not change its length or time.
      if (NOT_SESSION_LENGTH.test(input.slice(end))) continue;
      if (value >= 5 && value <= MAX_SESSION) hits.push({ minutes: value, index: match.index!, end });
    }
  };
  take(/\b(\d{1,2}) ?(?:h|hr|hrs|hour|hours) ?(?:and )?(\d{1,2}) ?(?:m|min|mins|minute|minutes)?\b/g,
    match => Number(match[1]) * 60 + Number(match[2]));
  take(/\b(\d{1,2}(?:\.\d+)?|an?|one|two|three|four) ?(and (?:a )?half )?(?:h|hr|hrs|hour|hours)\b( (?:and )?a half)?/g,
    match => Math.round(numberValue(match[1]) * 60) + (match[2] || match[3] ? 30 : 0));
  take(/\bhalf (?:an )?(?:hour|hr)\b/g, () => 30);
  take(/\b(\d{1,3}) ?(?:m|min|mins|minute|minutes)\b/g, match => Number(match[1]));
  return { text, hits };
}

/** "push it back 30 mins", "an hour later", "bring it forward by 1h". */
function shiftFor(text: string, hit: DurationHit): number | null {
  const before = text.slice(0, hit.index);
  const after = text.slice(hit.end);
  if (/^\s*(?:later|back)\b/.test(after)) return hit.minutes;
  if (/^\s*(?:earlier|forward|sooner)\b/.test(after)) return -hit.minutes;
  const verb = /\b(push|pushed|move|moved|shift|shifted|delay|delayed|postpone|bring|brought|start|starting)\b(?:\s+(?:it|the session|session|the class|class|the lesson|lesson|training|things))?\s*(back|later|forward|earlier|up)?\s*(?:by)?\s*$/.exec(before);
  if (!verb) return null;
  if (verb[2] === 'forward' || verb[2] === 'earlier' || verb[2] === 'up' || verb[1].startsWith('bring') || verb[1] === 'brought') return -hit.minutes;
  if (!verb[2] && (verb[1].startsWith('start'))) return null;
  return hit.minutes;
}

function timeTokens(text: string): TimeToken[] {
  const tokens: TimeToken[] = [];
  const pattern = /(?<![\w$/.:#])(?:(\d{1,2})[:.](\d{2})(?!\d)(?:\s?(am|pm|nn|mn)\b)?|(\d{3,4})(?!\d)(?:\s?(am|pm|nn|hrs|hr|h)\b)?|(\d{1,2})(?![\d.:/])(?:\s?(am|pm|nn|mn)\b)?)/g;
  for (const match of text.matchAll(pattern)) {
    let hour: number; let minute: number; let suffix: string | null; let explicit: boolean;
    if (match[1] !== undefined) {
      hour = Number(match[1]); minute = Number(match[2]); suffix = match[3] ?? null; explicit = true;
    } else if (match[4] !== undefined) {
      const digits = match[4];
      hour = Number(digits.slice(0, -2)); minute = Number(digits.slice(-2)); suffix = match[5] ?? null;
      if (suffix === 'hrs' || suffix === 'hr' || suffix === 'h') suffix = '24h';
      // "0930" is 24-hour; "930" without a suffix needs a cue like any bare number.
      if (digits.length === 4 && digits.startsWith('0')) suffix ??= '24h';
      explicit = !!suffix;
    } else {
      hour = Number(match[6]); minute = 0; suffix = match[7] ?? null; explicit = !!suffix;
    }
    if (minute > 59 || hour > 23) continue;
    if ((suffix === 'am' || suffix === 'pm') && (hour < 1 || hour > 12)) continue;
    tokens.push({ index: match.index!, end: match.index! + match[0].length, hour, minute, suffix, explicit });
  }
  return tokens;
}

function candidates(token: TimeToken): number[] {
  const { hour, minute, suffix } = token;
  if (suffix === 'am') return [(hour % 12) * 60 + minute];
  if (suffix === 'pm') return [((hour % 12) + 12) * 60 + minute];
  if (suffix === 'nn') return [12 * 60 + minute];
  if (suffix === 'mn') return [minute];
  if (suffix === '24h' || hour >= 13 || hour === 0) return [hour * 60 + minute];
  return [(hour % 12) * 60 + minute, ((hour % 12) + 12) * 60 + minute];
}

type Meridiem = 'am' | 'pm' | null;

/**
 * Pick am or pm the way a coach would read it. Nobody trains at 3am, so "3"
 * is 3pm and "12" is noon; context words ("morning", "tonight") decide next;
 * then the time already under discussion ("9am... can do 11?") anchors it;
 * then sensible coaching hours (7-11 is morning, everything else afternoon).
 */
function chooseTime(options: number[], meridiem: Meridiem, reference: number | null, notBefore: number | null) {
  if (options.length === 1) return options[0];
  const plausible = options.filter(value => value >= EARLIEST_PLAUSIBLE && value <= LATEST_PLAUSIBLE);
  if (plausible.length === 1) return plausible[0];
  if (!plausible.length) return null;
  const [am, pm] = plausible;
  if (meridiem === 'am') return am;
  if (meridiem === 'pm') return pm;
  if (notBefore !== null) {
    const later = plausible.filter(value => value > notBefore);
    if (later.length === 1) return later[0];
  }
  if (reference !== null) {
    return Math.abs(am - reference) <= Math.abs(pm - reference) ? am : pm;
  }
  return am >= 7 * 60 && am < 12 * 60 ? am : pm;
}

function resolveRange(first: TimeToken, second: TimeToken, meridiem: Meridiem, reference: number | null, notBefore: number | null) {
  const valid = candidates(first).flatMap(start => candidates(second).map(end => ({ start, end })))
    .filter(pair => pair.end - pair.start >= MIN_SESSION && pair.end - pair.start <= MAX_SESSION);
  const plausible = valid.filter(pair => pair.start >= EARLIEST_PLAUSIBLE && pair.start <= LATEST_PLAUSIBLE);
  // "9-1030am" lends its suffix to 9; an explicit "5am-6am" is believed as written.
  const pairs = plausible.length ? plausible : candidates(first).length === 1 ? valid : [];
  if (pairs.length <= 1) return pairs[0] ?? null;
  const starts = [...new Set(pairs.map(pair => pair.start))].sort((a, b) => a - b);
  const preferred = chooseTime(starts, meridiem, reference, notBefore);
  return pairs.filter(pair => pair.start === preferred)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] ?? pairs[0];
}

function meridiemOf(text: string): Meridiem {
  const am = AM_CONTEXT.test(text);
  const pm = PM_CONTEXT.test(text);
  return am === pm ? null : am ? 'am' : 'pm';
}

function venueTokens(value: string) {
  return normalize(value).split(/[^a-z0-9']+/).filter(word => word.length >= 4 && !VENUE_STOPWORDS.has(word) && !/^\d+$/.test(word));
}

function matchVenue(text: string, venues: ScheduleVenue[]): string | null {
  const words = new Set(text.split(/[^a-z0-9']+/).filter(Boolean));
  const fullName = venues.filter(venue => {
    const name = normalize(venue.name);
    return name.length >= 3 && text.includes(name);
  });
  if (fullName.length) return fullName.sort((a, b) => b.name.length - a.name.length)[0].id;
  const byToken = new Map<string, number>();
  for (const venue of venues) {
    const own = new Set([...venueTokens(venue.name), ...venueTokens(venue.address ?? '')]);
    const score = [...own].filter(token => words.has(token)).length;
    if (score) byToken.set(venue.id, score);
  }
  if (!byToken.size) return null;
  const best = Math.max(...byToken.values());
  const winners = [...byToken].filter(([, score]) => score === best);
  // Two venues sharing a word ("Bishan Hall" and "Bishan Court") is not a choice.
  return winners.length === 1 ? winners[0][0] : null;
}

function parseMessage(body: string, at: DateTime, draft: Draft | null, venues: ScheduleVenue[]): Parsed {
  const text = normalize(body);
  const result: Parsed = {
    date: null, busyDates: [], nextWeek: false, time: null, busyTimes: [], duration: null, shift: null,
    cancel: CANCEL.test(text), negative: BUSY.test(text), locationId: null,
  };
  const messageMeridiem = meridiemOf(text);
  const reference = draft?.start ?? null;
  const sentMinutes = at.hour * 60 + at.minute;
  const times: ParsedTime[] = [];
  const positiveText: string[] = [];
  for (const clause of clauses(text)) {
    const busy = BUSY.test(clause);
    if (!busy) positiveText.push(clause);
    const meridiem = meridiemOf(clause) ?? messageMeridiem;
    const dated = extractDates(clause, at);
    if (busy) result.busyDates.push(...dated.dates);
    else if (!result.date && dated.dates.length) result.date = dated.dates[0];
    if (dated.nextWeek && !busy) result.nextWeek = true;
    const timed = extractDurations(dated.text);
    for (const hit of timed.hits) {
      const shift = shiftFor(dated.text, hit);
      if (busy) continue;
      if (shift !== null) result.shift ??= shift;
      else if (hit.minutes >= MIN_SESSION) result.duration ??= hit.minutes;
    }
    const scan = timed.text;
    const statedToday = dated.dates[0] === at.toISODate() || (!dated.dates.length && !draft?.date);
    const notBefore = statedToday ? sentMinutes : null;
    const tokens = timeTokens(scan);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      // Cue words are read from the original clause: blanking keeps every
      // position, so "tmr 9" still sees "tmr" before the 9.
      const before = clause.slice(0, token.index);
      const following = tokens[index + 1];
      const isRange = !!following && RANGE_JOINER.test(scan.slice(token.end, following.index));
      const last = isRange ? following : token;
      const after = clause.slice(last.end);
      if (UNIT_BEFORE.test(before) || UNIT_AFTER.test(after)) {
        if (isRange) index += 1;
        continue;
      }
      if (!isRange && !token.explicit) {
        const rest = (scan.slice(0, token.index) + scan.slice(token.end)).trim();
        if (!BARE_CUE.test(before) && !BARE_FOLLOWER.test(after) && !FILLER_ONLY.test(rest)) continue;
      }
      const range = isRange ? resolveRange(token, following, meridiem, reference, notBefore) : null;
      if (isRange) index += 1;
      const start = range?.start ?? chooseTime(candidates(token), meridiem, reference, notBefore);
      if (start === null) continue;
      if (busy || NOT_THIS_TIME.test(before)) {
        result.busyTimes.push(start);
        continue;
      }
      const score = (STRONG_CUE.test(before) ? 2 : 0) + (token.explicit || isRange ? 1 : 0);
      times.push({ start, end: range?.end ?? null, score });
    }
  }
  result.time = times.reduce<ParsedTime | null>((best, time) => !best || time.score > best.score ? time : best, null);
  result.locationId = positiveText.length ? matchVenue(positiveText.join(' '), venues) : null;
  return result;
}

function inferDate(draft: Draft) {
  const at = draft.timeSetAt!;
  // A start still comfortably ahead today means today; otherwise tomorrow.
  const sameDay = draft.start! > at.hour * 60 + at.minute + 60;
  return (sameDay ? at.startOf('day') : at.startOf('day').plus({ days: 1 })).toISODate()!;
}

function emptyDraft(sourceMessageId: string): Draft {
  return {
    date: null, dateRejected: false, start: null, duration: null, locationId: null, timeSetAt: null, sourceMessageId,
  };
}

/**
 * The session the conversation has currently agreed on, or null. Replays
 * messages after the most recent proposal: posting one turns the discussion
 * into a real card, so the detector starts over from there.
 */
export function detectScheduleDraft(
  messages: readonly ScheduleMessage[],
  options: { timezone: string; venues?: readonly ScheduleVenue[]; now?: Date },
): ScheduleDraft | null {
  const venues = [...(options.venues ?? [])];
  const now = options.now ?? new Date();
  let draft: Draft | null = null;
  for (const message of messages) {
    if (message.kind === 'PROPOSAL') { draft = null; continue; }
    if (message.kind !== 'TEXT') continue;
    const at = DateTime.fromJSDate(message.createdAt, { zone: options.timezone });
    if (!at.isValid) continue;
    const parsed = parseMessage(message.body, at, draft, venues);
    const positive = !!(parsed.date || parsed.time || parsed.shift !== null || parsed.duration !== null
      || parsed.locationId || parsed.nextWeek);
    if (!positive) {
      // "Sorry, can't make it" or "cancel" with nothing new on offer ends
      // the plan; a turned-down date or time keeps the rest for a counter.
      if (parsed.cancel || (parsed.negative && !parsed.busyDates.length && !parsed.busyTimes.length)) {
        draft = null;
        continue;
      }
    }
    const next: Draft = draft ? { ...draft } : emptyDraft(message.id);
    let changed = false;
    if (!parsed.date && draft?.date && parsed.busyDates.includes(draft.date)) {
      next.date = null; next.dateRejected = true; changed = true;
    }
    if (!parsed.time && draft?.start !== null && draft?.start !== undefined && parsed.busyTimes.includes(draft.start)) {
      next.start = null; next.timeSetAt = null; changed = true;
    }
    if (parsed.date) {
      next.date = parsed.date; next.dateRejected = false; changed = true;
    } else if (parsed.nextWeek && (next.date || (next.start !== null && next.timeSetAt))) {
      const from = next.date ?? inferDate(next);
      next.date = DateTime.fromISO(from, { zone: options.timezone }).plus({ weeks: 1 }).toISODate()!;
      next.dateRejected = false; changed = true;
    }
    if (parsed.time) {
      next.start = parsed.time.start;
      if (parsed.time.end !== null) next.duration = parsed.time.end - parsed.time.start;
      else if (parsed.duration !== null) next.duration = parsed.duration;
      next.timeSetAt = at;
      changed = true;
    } else if (parsed.shift !== null && next.start !== null) {
      next.start = Math.min(Math.max(next.start + parsed.shift, 0), MINUTES_PER_DAY - MIN_SESSION);
      changed = true;
    } else if (parsed.duration !== null) {
      next.duration = parsed.duration;
      changed = true;
    }
    if (parsed.locationId) { next.locationId = parsed.locationId; changed = true; }
    if (changed) {
      next.sourceMessageId = message.id;
      draft = next;
    }
  }
  if (!draft || draft.start === null || draft.dateRejected) return null;
  const date = draft.date ?? (draft.timeSetAt ? inferDate(draft) : null);
  if (!date) return null;
  const startAt = DateTime.fromISO(date, { zone: options.timezone }).startOf('day').plus({ minutes: draft.start });
  if (!startAt.isValid || startAt.toMillis() <= now.getTime()) return null;
  const end = draft.duration !== null ? draft.start + draft.duration : null;
  return {
    date,
    startMinutes: draft.start,
    endMinutes: end !== null && end <= MINUTES_PER_DAY ? end : null,
    durationMinutes: end !== null && end <= MINUTES_PER_DAY ? draft.duration : null,
    locationId: draft.locationId,
    startAt: startAt.toJSDate(),
    sourceMessageId: draft.sourceMessageId,
  };
}
