/**
 * Adapted for timemark-docker on top of timemark-vercel v2.30.
 *
 * Contract changes vs the v2.16-era tests this file used to carry:
 *  - `replace` now DELETES prior external-calendar rows up front and fetches
 *    afterwards, so a failed fetch still leaves prior imports deleted and only
 *    records an error (v2.16 fetched successfully before deleting).
 *  - Fetching goes through the global `fetch` (redirects rejected, non-2xx
 *    errors) guarded by utils/url-safety's `isSafePublicUrl`; the v2.16
 *    `safeAxiosGet` seam is gone.
 *  - Parsing goes through utils/ics-parser's permissive `parseIcsEvents`, so
 *    the old "reject unqualified / date-time / duplicate / implausible DTSTART"
 *    cases now import instead of failing the feed (see ics-parser.test.ts).
 *  - Caps kept: first 5 URLs, first 100 events per URL. Over-limit input is
 *    truncated silently (v2.16 rejected the whole sync).
 *  - Deleted case: "does not send HTTP requests to URLs with userinfo" - the
 *    v2.30 url-safety has no userinfo check, so that hardening no longer exists
 *    at this seam (credential-bearing URLs are only rejected by DNS/IP rules).
 *  - `queryTransaction` is no longer used by the service; only `query` is.
 *  - The db layer auto-parses JSON columns on read, so mocked
 *    `external_calendar_urls` rows are arrays (as the service receives them).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, fetchMock, isSafePublicUrlMock, createEventMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  fetchMock: vi.fn(),
  isSafePublicUrlMock: vi.fn(),
  createEventMock: vi.fn(),
}));

vi.mock('../db/index.js', () => ({ query: queryMock }));
vi.mock('../utils/url-safety.js', () => ({ isSafePublicUrl: isSafePublicUrlMock }));
vi.mock('../services/event.service.js', () => ({ createEvent: createEventMock }));

import { syncAllExternalCalendars, syncExternalCalendarsForUser } from '../services/calendar-sync.service.js';

function icsResponse(body: string) {
  return { ok: true, status: 200, text: async () => body };
}

const feed = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//TimeMark//Calendar Sync Test//EN',
  'BEGIN:VEVENT',
  'SUMMARY:Replacement event',
  'DTSTART;VALUE=DATE:20261001',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

beforeEach(() => {
  queryMock.mockReset().mockImplementation(async (sql: unknown) => {
    const s = String(sql);
    if (s.includes('SELECT external_calendar_urls')) {
      return {
        rows: [{
          external_calendar_urls: ['https://calendar.example/events.ics'],
          external_calendar_sync_strategy: 'replace',
        }],
        rowCount: 1,
      };
    }
    if (s.includes('DELETE FROM events')) return { rows: [], rowCount: 2 };
    return { rows: [], rowCount: 0 };
  });
  isSafePublicUrlMock.mockReset().mockResolvedValue({ safe: true });
  fetchMock.mockReset().mockResolvedValue(icsResponse(feed));
  vi.stubGlobal('fetch', fetchMock);
  createEventMock.mockReset().mockResolvedValue({ id: 1 });
});

describe('syncExternalCalendarsForUser replace strategy (v2.30 contract)', () => {
  it('deletes prior imports first and records the error when a feed fetch fails', async () => {
    fetchMock.mockRejectedValue(new Error('DNS unavailable'));

    const result = await syncExternalCalendarsForUser(7);

    expect(result).toMatchObject({ imported: 0, deleted: 2 });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('DNS unavailable');
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM events'))).toBe(true);
    expect(createEventMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-calendar HTTP response', '<html>upstream error</html>'],
    ['a VEVENT without a SUMMARY', [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'DTSTART;VALUE=DATE:20261001',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join(String.fromCharCode(13, 10))],
    ['text that merely mentions calendar markers', 'not an iCalendar document: BEGIN:VCALENDAR ... END:VCALENDAR'],
    ['a structurally valid but empty calendar', [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TimeMark//Calendar Sync Test//EN',
      'END:VCALENDAR',
    ].join(String.fromCharCode(13, 10))],
  ])('clears prior imports without an error entry when the feed has %s', async (_caseName, body) => {
    fetchMock.mockResolvedValue(icsResponse(body));

    const result = await syncExternalCalendarsForUser(7);

    expect(result).toMatchObject({ imported: 0, deleted: 2, errors: [] });
    expect(createEventMock).not.toHaveBeenCalled();
  });

  it('rejects redirect responses before importing anything', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 302, text: async () => feed });

    const result = await syncExternalCalendarsForUser(7);

    expect(result.imported).toBe(0);
    expect(result.deleted).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Redirects are not allowed');
    expect(createEventMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a date-time DTSTART', ['DTSTART:20261001T193000Z']],
    ['an implausible calendar date', ['DTSTART;VALUE=DATE:20260230']],
    ['an unqualified eight-digit DTSTART', ['DTSTART:20261001']],
    ['duplicate DTSTART properties', [
      'DTSTART;VALUE=DATE:20261001',
      'DTSTART;VALUE=DATE:20261002',
    ]],
  ])('imports a VEVENT with %s (v2.30 parser takes the first 8 digits)', async (_caseName, dateLines) => {
    fetchMock.mockResolvedValue(icsResponse([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TimeMark//Calendar Sync Test//EN',
      'BEGIN:VEVENT',
      'SUMMARY:Unsupported date event',
      ...dateLines,
      'END:VEVENT',
      'END:VCALENDAR',
    ].join(String.fromCharCode(13, 10))));

    const result = await syncExternalCalendarsForUser(7);

    expect(result).toMatchObject({ imported: 1, deleted: 2, errors: [] });
  });

  it.each([
    ['headers nested in an event', [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'VERSION:2.0',
      'PRODID:-//TimeMark//Calendar Sync Test//EN',
      'SUMMARY:Misplaced headers',
      'DTSTART;VALUE=DATE:20261001',
      'END:VEVENT',
      'END:VCALENDAR',
    ], 1],
    ['an unsupported VTODO component', [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TimeMark//Calendar Sync Test//EN',
      'BEGIN:VTODO',
      'SUMMARY:Unsupported task',
      'DTSTART;VALUE=DATE:20261001',
      'END:VTODO',
      'END:VCALENDAR',
    ], 0],
    ['an empty VTIMEZONE', [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TimeMark//Calendar Sync Test//EN',
      'BEGIN:VTIMEZONE',
      'TZID:Test/Zone',
      'END:VTIMEZONE',
      'END:VCALENDAR',
    ], 0],
    ['an empty STANDARD component', [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TimeMark//Calendar Sync Test//EN',
      'BEGIN:VTIMEZONE',
      'TZID:Test/Zone',
      'BEGIN:STANDARD',
      'END:STANDARD',
      'END:VTIMEZONE',
      'END:VCALENDAR',
    ], 0],
    ['an invalid timezone observance DTSTART', [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TimeMark//Calendar Sync Test//EN',
      'BEGIN:VTIMEZONE',
      'TZID:Test/Zone',
      'BEGIN:STANDARD',
      'DTSTART:garbage',
      'TZOFFSETFROM:-0400',
      'TZOFFSETTO:-0500',
      'END:STANDARD',
      'END:VTIMEZONE',
      'END:VCALENDAR',
    ], 0],
    ['an invalid timezone offset', [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TimeMark//Calendar Sync Test//EN',
      'BEGIN:VTIMEZONE',
      'TZID:Test/Zone',
      'BEGIN:STANDARD',
      'DTSTART:20261001T020000',
      'TZOFFSETFROM:bogus',
      'TZOFFSETTO:-0500',
      'END:STANDARD',
      'END:VTIMEZONE',
      'END:VCALENDAR',
    ], 0],
    ['an invalid timezone date', [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TimeMark//Calendar Sync Test//EN',
      'BEGIN:VTIMEZONE',
      'TZID:Test/Zone',
      'BEGIN:STANDARD',
      'DTSTART:20260230T020000',
      'TZOFFSETFROM:-0400',
      'TZOFFSETTO:-0500',
      'END:STANDARD',
      'END:VTIMEZONE',
      'END:VCALENDAR',
    ], 0],
    ['an out-of-range timezone offset', [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TimeMark//Calendar Sync Test//EN',
      'BEGIN:VTIMEZONE',
      'TZID:Test/Zone',
      'BEGIN:STANDARD',
      'DTSTART:20261001T020000',
      'TZOFFSETFROM:+2500',
      'TZOFFSETTO:-0500',
      'END:STANDARD',
      'END:VTIMEZONE',
      'END:VCALENDAR',
    ], 0],
  ])('imports %i event(s) when the feed has %s', async (_caseName, lines, expectedImported) => {
    fetchMock.mockResolvedValue(icsResponse(lines.join(String.fromCharCode(13, 10))));

    const result = await syncExternalCalendarsForUser(7);

    expect(result.imported).toBe(expectedImported);
    expect(result.deleted).toBe(2);
    expect(result.errors).toEqual([]);
  });

  it('accepts well-formed VTIMEZONE observances in replace mode', async () => {
    fetchMock.mockResolvedValue(icsResponse([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TimeMark//Calendar Sync Test//EN',
      'BEGIN:VTIMEZONE',
      'TZID:America/New_York',
      'BEGIN:STANDARD',
      'DTSTART:20261101T020000',
      'TZOFFSETFROM:-0400',
      'TZOFFSETTO:-0500',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:20260308T020000',
      'TZOFFSETFROM:-0500',
      'TZOFFSETTO:-0400',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'SUMMARY:Valid timezone event',
      'DTSTART;VALUE=DATE:20261001',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join(String.fromCharCode(13, 10))));

    const result = await syncExternalCalendarsForUser(7);

    expect(result).toMatchObject({ imported: 1, deleted: 2, errors: [] });
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM events'))).toBe(true);
  });

  it('skips and records an error when url-safety rejects the URL', async () => {
    isSafePublicUrlMock.mockResolvedValue({ safe: false, reason: 'Hostname DNS resolution failed' });

    const result = await syncExternalCalendarsForUser(7);

    expect(result.imported).toBe(0);
    expect(result.deleted).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Hostname DNS resolution failed');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createEventMock).not.toHaveBeenCalled();
  });

  it('normalizes webcal:// to https:// for both the safety check and the fetch', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes('SELECT external_calendar_urls')) {
        return {
          rows: [{
            external_calendar_urls: ['webcal://calendar.example/events.ics'],
            external_calendar_sync_strategy: 'replace',
          }],
          rowCount: 1,
        };
      }
      if (s.includes('DELETE FROM events')) return { rows: [], rowCount: 2 };
      return { rows: [], rowCount: 0 };
    });

    await syncExternalCalendarsForUser(7);

    expect(isSafePublicUrlMock).toHaveBeenCalledWith('https://calendar.example/events.ics');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://calendar.example/events.ics');
    expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).toBe('manual');
  });

  it('marks created rows as external_calendar imports', async () => {
    await syncExternalCalendarsForUser(7);

    expect(createEventMock).toHaveBeenCalledTimes(1);
    const [userId, payload] = createEventMock.mock.calls[0] as [string, { name: string; reminderConfig: Record<string, unknown> }];
    expect(userId).toBe('7');
    expect(payload.name).toBe('Replacement event');
    expect(payload.reminderConfig.importSource).toBe('external_calendar');
  });

  it('filters bulk sync users via jsonb_array_length and syncs the survivors', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes('SELECT user_id FROM user_configs')) {
        // Only non-empty feeds survive the jsonb_array_length filter in v2.30.
        return { rows: [{ user_id: 9 }, { user_id: 10 }], rowCount: 2 };
      }
      if (s.includes('SELECT external_calendar_urls')) {
        return {
          rows: [{
            external_calendar_urls: ['https://calendar.example/events.ics'],
            external_calendar_sync_strategy: 'add_only',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    await syncAllExternalCalendars();

    expect(String(queryMock.mock.calls[0][0])).toContain('jsonb_array_length');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createEventMock).toHaveBeenCalledTimes(2);
  });

  it('imports from the first five sources when more than five are configured', async () => {
    const urls = Array.from({ length: 6 }, (_, index) => `https://calendar${index}.example/events.ics`);
    queryMock.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes('SELECT external_calendar_urls')) {
        return { rows: [{ external_calendar_urls: urls, external_calendar_sync_strategy: 'replace' }], rowCount: 1 };
      }
      if (s.includes('DELETE FROM events')) return { rows: [], rowCount: 2 };
      return { rows: [], rowCount: 0 };
    });

    const result = await syncExternalCalendarsForUser(7);

    expect(result).toMatchObject({ imported: 5, deleted: 2, errors: [] });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('imports the first 100 events when a replacement feed exceeds the event limit', async () => {
    const bulkFeed = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TimeMark//Calendar Sync Test//EN',
      ...Array.from({ length: 101 }, (_, index) => [
        'BEGIN:VEVENT',
        `SUMMARY:Replacement event ${index}`,
        'DTSTART;VALUE=DATE:20261001',
        'END:VEVENT',
      ]).flat(),
      'END:VCALENDAR',
    ].join(String.fromCharCode(13, 10));
    fetchMock.mockResolvedValue(icsResponse(bulkFeed));

    const result = await syncExternalCalendarsForUser(7);

    expect(result).toMatchObject({ imported: 100, deleted: 2, errors: [] });
    expect(createEventMock).toHaveBeenCalledTimes(100);
  });

  it('deduplicates add_only imports against existing rows', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes('SELECT external_calendar_urls')) {
        return {
          rows: [{
            external_calendar_urls: ['https://calendar.example/events.ics'],
            external_calendar_sync_strategy: 'add_only',
          }],
          rowCount: 1,
        };
      }
      if (s.includes('SELECT id FROM events')) return { rows: [{ id: 42 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const result = await syncExternalCalendarsForUser(7);

    expect(result).toMatchObject({ imported: 0, deleted: 0, errors: [] });
    expect(createEventMock).not.toHaveBeenCalled();
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM events'))).toBe(false);
  });
});
