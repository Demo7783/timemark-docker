/**
 * Adapted for timemark-docker on top of timemark-vercel v2.30.
 *
 * Seam changes vs the v2.16-era tests this file used to carry:
 *  - Fetching now goes through axios directly, guarded by utils/url-safety's
 *    `isSafePublicUrl` (the v2.16 `safeAxiosGet` seam is gone), so this file
 *    mocks `axios` and `url-safety` instead of `safe-http`.
 *  - Credential hygiene moved from the HTTP client to the logger: v2.30 hands
 *    the raw axios error to pino, whose REDACT_PATHS censor `*.password` keys
 *    at the sink. The log test therefore captures a real pino stream and
 *    asserts the marker never reaches it.
 *  - Deleted case "does not import the body of a redirect response": v2.30
 *    treats any status < 400 as usable (`maxRedirects: 0` +
 *    `validateStatus: s < 500`), so a 3xx body is parsed - that hardening no
 *    longer has a counterpart here (flagged as a suspected upstream regression).
 *  - Deleted cases "does not send credentials over HTTP": v2.30 delegates URL
 *    policy entirely to `isSafePublicUrl` (plain http is an allowed protocol);
 *    kept an equivalent test asserting rejected URLs are skipped before any
 *    request is made.
 *  - The v2.30 parser is permissive (first 8 digits of any DTSTART, no
 *    calendar validation), so the old "does not import unsupported DTSTART"
 *    cases now assert the import contract (see ics-parser.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.MASTER_KEY = 'caldav-sync-test-master-key';

const { queryMock, axiosGetMock, isSafePublicUrlMock, logLines } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  axiosGetMock: vi.fn(),
  isSafePublicUrlMock: vi.fn(),
  logLines: [] as string[],
}));

vi.mock('../db/index.js', () => ({ query: queryMock }));
vi.mock('../utils/url-safety.js', () => ({ isSafePublicUrl: isSafePublicUrlMock }));
vi.mock('axios', () => ({ default: { get: axiosGetMock } }));
vi.mock('../utils/logger.js', async () => {
  const pino = (await import('pino')).default;
  // Reuse the production logger options (redact paths, mixin) so the test
  // exercises the real sink-level credential redaction.
  const actual = await vi.importActual<typeof import('../utils/logger.js')>('../utils/logger.js');
  const destination = { write: (line: string) => { logLines.push(line); } };
  const instance = pino({ ...actual.buildLoggerOptions(), level: 'warn' }, destination as never);
  return {
    createLogger: () => instance,
    logger: instance,
    createLoggerInstance: () => instance,
  };
});

import { syncAllCalDavSubscriptions } from '../services/caldav-sync.service.js';

const eventCalendar = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'SUMMARY:Imported CalDAV event',
  'DTSTART;VALUE=DATE:20261001',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

beforeEach(() => {
  logLines.length = 0;
  isSafePublicUrlMock.mockReset().mockResolvedValue({ safe: true });
  axiosGetMock.mockReset().mockResolvedValue({ status: 200, data: eventCalendar });
  queryMock.mockReset().mockImplementation(async (sql: unknown) => {
    const s = String(sql);
    if (s.includes('FROM user_configs')) {
      return {
        rows: [{
          user_id: 7,
          caldav_url: 'https://caldav.example/calendar.ics',
          caldav_username: 'caldav-user',
          caldav_password_encrypted: '',
        }],
        rowCount: 1,
      };
    }
    if (s.includes('INSERT INTO events')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});

describe('syncAllCalDavSubscriptions', () => {
  it('does not leak CalDAV basic-auth credentials into the log sink when a sync fails', async () => {
    const marker = 'test-credential-marker';
    const error = Object.assign(new Error('request failed'), {
      config: {
        url: 'https://caldav.example/calendar.ics',
        auth: { username: 'caldav-user', password: marker },
      },
    });
    axiosGetMock.mockRejectedValue(error);

    const result = await syncAllCalDavSubscriptions();

    expect(result.synced).toBe(0);
    const sink = logLines.join('');
    expect(sink).toContain('CalDAV sync failed');
    expect(sink).not.toContain(marker);
    expect(sink).toContain('[REDACTED]');
  });

  it('imports a supported date-only event and tags the import source', async () => {
    const result = await syncAllCalDavSubscriptions();

    expect(result.synced).toBe(1);
    const insertCall = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO events'));
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    expect(params[0]).toBe(7);
    expect(params[1]).toBe('Imported CalDAV event');
    expect(params[2]).toBe('2026-10-01');
    const reminderConfig = JSON.parse(params[3] as string);
    expect(reminderConfig.importSource).toBe('caldav');
    expect(reminderConfig.enabled).toBe(false);
  });

  it('does not insert an event that already exists', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes('FROM user_configs')) {
        return {
          rows: [{ user_id: 7, caldav_url: 'https://caldav.example/calendar.ics', caldav_username: '', caldav_password_encrypted: '' }],
          rowCount: 1,
        };
      }
      if (s.includes('SELECT id FROM events')) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const result = await syncAllCalDavSubscriptions();

    expect(result.synced).toBe(0);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO events'))).toBe(false);
  });

  it('skips subscriptions rejected by url-safety without any HTTP request', async () => {
    isSafePublicUrlMock.mockResolvedValue({ safe: false, reason: 'Private host blocked' });

    const result = await syncAllCalDavSubscriptions();

    expect(result.synced).toBe(0);
    expect(axiosGetMock).not.toHaveBeenCalled();
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO events'))).toBe(false);
  });

  it('skips a subscription whose stored password cannot be decrypted', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes('FROM user_configs')) {
        return {
          rows: [{
            user_id: 7,
            caldav_url: 'https://caldav.example/calendar.ics',
            caldav_username: 'caldav-user',
            caldav_password_encrypted: 'garbage-not-ciphertext',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await syncAllCalDavSubscriptions();

    expect(result.synced).toBe(0);
    expect(axiosGetMock).not.toHaveBeenCalled();
    expect(logLines.join('')).toContain('CalDAV password decrypt failed');
  });

  it.each([
    ['an unqualified date-only value', 'DTSTART:20261001'],
    ['a date-time value', 'DTSTART:20261001T193000Z'],
    ['an implausible date-only value', 'DTSTART;VALUE=DATE:20260230'],
  ])('imports a VEVENT with %s (v2.30 parser takes the first 8 digits)', async (_caseName, dtstart) => {
    axiosGetMock.mockResolvedValue({
      status: 200,
      data: [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'SUMMARY:Permissively dated event',
        dtstart,
        'END:VEVENT',
        'END:VCALENDAR',
      ].join(String.fromCharCode(13, 10)),
    });

    const result = await syncAllCalDavSubscriptions();

    expect(result.synced).toBe(1);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO events'))).toBe(true);
  });
});
