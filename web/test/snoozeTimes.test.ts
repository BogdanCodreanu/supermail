import { describe, expect, it } from 'vitest';
import { parseSnooze, presets } from '../src/lib/snoozeTimes';

// Local times on purpose: snooze presets are wall-clock times for the owner.
const at = (s: string) => new Date(s);
const preset = (now: string, label: string) => presets(at(now)).find((p) => p.label === label)?.at;

describe('presets', () => {
  it('lists Later today, Tomorrow morning, This weekend, Next week in that order', () => {
    expect(presets(at('2026-10-29T10:00')).map((p) => p.label)).toEqual(['Later today', 'Tomorrow morning', 'This weekend', 'Next week']);
  });

  it('Later today is now + 3 h rounded up to the hour', () => {
    expect(presets(at('2026-10-29T10:20'))[0]!.at).toEqual(at('2026-10-29T14:00'));
    expect(presets(at('2026-10-29T10:00'))[0]!.at).toEqual(at('2026-10-29T13:00'));
    expect(presets(at('2026-10-29T15:00'))[0]!.at).toEqual(at('2026-10-29T18:00'));
  });

  it('Later today past 18:00 becomes tomorrow 08:00', () => {
    expect(presets(at('2026-10-29T19:30'))[0]!.at).toEqual(at('2026-10-30T08:00'));
    expect(presets(at('2026-10-29T15:10'))[0]!.at).toEqual(at('2026-10-30T08:00'));
    expect(presets(at('2026-10-31T23:30'))[0]!.at).toEqual(at('2026-11-01T08:00'));
  });

  it('Tomorrow morning is tomorrow 08:00, across a month end', () => {
    expect(preset('2026-10-29T19:30', 'Tomorrow morning')).toEqual(at('2026-10-30T08:00'));
    expect(preset('2026-10-31T01:00', 'Tomorrow morning')).toEqual(at('2026-11-01T08:00'));
  });

  it('This weekend is Saturday 09:00, or next Saturday when it is already the weekend', () => {
    expect(preset('2026-10-29T10:00', 'This weekend')).toEqual(at('2026-10-31T09:00')); // Thu
    expect(preset('2026-10-30T22:00', 'This weekend')).toEqual(at('2026-10-31T09:00')); // Fri
    expect(preset('2026-10-31T07:00', 'This weekend')).toEqual(at('2026-11-07T09:00')); // Sat
    expect(preset('2026-11-01T10:00', 'This weekend')).toEqual(at('2026-11-07T09:00')); // Sun
  });

  it('Next week is next Monday 08:00, a full week ahead on a Monday', () => {
    expect(preset('2026-10-29T10:00', 'Next week')).toEqual(at('2026-11-02T08:00')); // Thu
    expect(preset('2026-11-01T10:00', 'Next week')).toEqual(at('2026-11-02T08:00')); // Sun
    expect(preset('2026-11-02T07:00', 'Next week')).toEqual(at('2026-11-09T08:00')); // Mon
  });
});

describe('parseSnooze', () => {
  const thu = at('2026-10-29T10:00'); // Thursday 29 Oct 2026

  it('parses "fri 9am" as Friday 30 Oct 09:00', () => {
    expect(parseSnooze('fri 9am', thu)).toEqual(at('2026-10-30T09:00'));
  });

  it('reads bare times forward: "8am" after 8am means tomorrow', () => {
    expect(parseSnooze('8am', thu)).toEqual(at('2026-10-30T08:00'));
    expect(parseSnooze('in 2 hours', thu)).toEqual(at('2026-10-29T12:00'));
  });

  it('returns null for the past, nonsense and empty text', () => {
    expect(parseSnooze('yesterday', thu)).toBeNull();
    expect(parseSnooze('2 days ago', thu)).toBeNull();
    expect(parseSnooze('blah', thu)).toBeNull();
    expect(parseSnooze('   ', thu)).toBeNull();
  });
});
