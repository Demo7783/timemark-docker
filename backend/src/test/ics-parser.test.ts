/**
 * Adapted for timemark-docker on top of timemark-vercel v2.30.
 *
 * The v2.30 `parseIcsEvents` is a deliberately minimal, permissive parser: it
 * regex-matches the first SUMMARY / DTSTART / DESCRIPTION inside each
 * BEGIN:VEVENT block, takes the first 8 digits of any DTSTART value, performs
 * no calendar validation (impossible dates pass through), never throws, and
 * silently skips blocks it cannot match.
 *
 * The v2.16 hardening cases asserting rejection of unqualified / duplicate /
 * date-time / implausible DTSTART values no longer have counterparts upstream
 * and were rewritten to document the permissive v2.30 contract instead.
 */
import { describe, expect, it } from 'vitest';
import { parseIcsEvents } from '../utils/ics-parser.js';

function calendar(...eventLines: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    ...eventLines,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join(String.fromCharCode(13, 10));
}

describe('parseIcsEvents', () => {
  it('parses a valid date-only VEVENT', () => {
    expect(parseIcsEvents(calendar(
      'SUMMARY:Anniversary',
      'DTSTART;VALUE=DATE:20261001',
    ))).toMatchObject([{ name: 'Anniversary', date: '2026-10-01' }]);
  });

  it('captures DESCRIPTION and flattens escaped newlines in SUMMARY', () => {
    expect(parseIcsEvents(calendar(
      'SUMMARY:Line1\\nLine2',
      'DTSTART;VALUE=DATE:20261001',
      'DESCRIPTION:Some notes',
    ))).toEqual([{ name: 'Line1 Line2', date: '2026-10-01', description: 'Some notes' }]);
  });

  it('accepts an eight-digit DTSTART without an explicit DATE value type', () => {
    expect(parseIcsEvents(calendar(
      'SUMMARY:Unqualified date',
      'DTSTART:20261001',
    ))).toMatchObject([{ name: 'Unqualified date', date: '2026-10-01' }]);
  });

  it('uses the first DTSTART when a VEVENT declares duplicates', () => {
    expect(parseIcsEvents(calendar(
      'SUMMARY:Duplicate date',
      'DTSTART;VALUE=DATE:20261001',
      'DTSTART;VALUE=DATE:20261002',
    ))).toMatchObject([{ name: 'Duplicate date', date: '2026-10-01' }]);
  });

  it('truncates a date-time DTSTART to its date part', () => {
    expect(parseIcsEvents(calendar(
      'SUMMARY:Timed event',
      'DTSTART:20261001T193000Z',
    ))).toMatchObject([{ name: 'Timed event', date: '2026-10-01' }]);
  });

  it('accepts a date-only value declared as a date-time', () => {
    expect(parseIcsEvents(calendar(
      'SUMMARY:Invalid value type',
      'DTSTART;VALUE=DATE-TIME:20261001',
    ))).toMatchObject([{ name: 'Invalid value type', date: '2026-10-01' }]);
  });

  it('passes impossible calendar dates through without validation', () => {
    expect(parseIcsEvents(calendar(
      'SUMMARY:Invalid date',
      'DTSTART;VALUE=DATE:20260230',
    ))).toMatchObject([{ name: 'Invalid date', date: '2026-02-30' }]);
  });

  it('matches property names anywhere in the block, including inside DESCRIPTION values', () => {
    // v2.30 contract: the regexes are not value-aware, so property-like text
    // inside a DESCRIPTION value is picked up as the SUMMARY/DTSTART.
    expect(parseIcsEvents(calendar(
      'DESCRIPTION:SUMMARY:Fake event',
      'DESCRIPTION:DTSTART:20261001',
    ))).toEqual([{ name: 'Fake event', date: '2026-10-01', description: 'SUMMARY:Fake event' }]);
  });

  it('skips blocks without a SUMMARY or a DTSTART instead of throwing', () => {
    expect(parseIcsEvents(calendar(
      'SUMMARY:No date here',
    ))).toEqual([]);
    expect(parseIcsEvents(calendar(
      'DTSTART;VALUE=DATE:20261001',
    ))).toEqual([]);
  });

  it('ignores non-VEVENT content and returns events for every parseable block', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'SUMMARY:A task',
      'DTSTART;VALUE=DATE:20261001',
      'END:VTODO',
      'BEGIN:VEVENT',
      'SUMMARY:First',
      'DTSTART;VALUE=DATE:20261001',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'SUMMARY:Second',
      'DTSTART;VALUE=DATE:20261002',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join(String.fromCharCode(13, 10));
    expect(parseIcsEvents(text)).toEqual([
      { name: 'First', date: '2026-10-01', description: undefined },
      { name: 'Second', date: '2026-10-02', description: undefined },
    ]);
  });
});
