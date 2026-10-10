/**
 * Adapted for timemark-docker on top of timemark-vercel v2.30.
 *
 * Contract changes vs the v2.16-era tests this file used to carry:
 *  - The docker db layer auto-parses JSON columns on read, so mocked
 *    `calendar_feed_tokens` / `external_calendar_urls` rows are arrays (as the
 *    route receives them); the route itself no longer JSON.parse-s anything.
 *  - The route no longer uses utils/client-ip's `getRequestOrigin`; URLs are
 *    built from the Host / X-Forwarded-Proto headers (defaults under
 *    `app.request`: localhost + https).
 *  - /integrations now also provisions inbox receive tokens on demand via
 *    services/inbox.service (mocked here).
 *  - Over-limit external_calendar_urls lists are truncated to 5 (v2.16
 *    rejected the request with 400).
 *  - Malformed stored token JSON is treated as an empty list (v2.16 answered
 *    500 by refusing to overwrite).
 *  - Added coverage for the v2.30 /import-ics body-size and parse guards.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  createEvent: vi.fn(),
  getInboxReceiveTokens: vi.fn(),
  authMiddleware: vi.fn(async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: '7', username: 'admin' });
    await next();
  }),
}));

vi.mock('../db/index.js', () => ({ query: mocks.query }));
vi.mock('../services/event.service.js', () => ({ createEvent: mocks.createEvent }));
vi.mock('../services/inbox.service.js', () => ({ getInboxReceiveTokens: mocks.getInboxReceiveTokens }));
vi.mock('../middleware/auth.middleware.js', () => ({ authMiddleware: mocks.authMiddleware }));

import calendarImport from '../routes/calendar-import.js';

beforeEach(() => {
  mocks.query.mockReset();
  mocks.createEvent.mockReset().mockResolvedValue({ id: 1 });
  mocks.getInboxReceiveTokens.mockReset().mockResolvedValue({
    inboxReceiveToken: 'inbox-token-1',
    inboxReceiveSecret: 'inbox-secret-1',
  });
});

describe('calendar integration settings', () => {
  it('returns saved integration lists and provisions inbox receive tokens', async () => {
    mocks.query.mockResolvedValue({
      rows: [{
        webhook_inbound_token: null,
        calendar_feed_token: null,
        calendar_feed_tokens: [{ name: 'Primary', token: 'feed-token-1' }],
        external_calendar_urls: ['https://calendar.example/events.ics'],
        external_calendar_sync_strategy: 'replace',
      }],
      rowCount: 1,
    });

    const response = await calendarImport.request('/integrations');
    const result = await response.json() as any;

    expect(response.status).toBe(200);
    expect(result.data.calendarFeedTokens).toEqual([{
      name: 'Primary',
      url: 'https://localhost/api/calendar/feed/feed-token-1.ics',
    }]);
    expect(result.data.externalCalendarUrls).toEqual(['https://calendar.example/events.ics']);
    expect(result.data.externalCalendarSyncStrategy).toBe('replace');
    expect(mocks.getInboxReceiveTokens).toHaveBeenCalledWith(7);
    expect(result.data.inboxReceiveUrl).toBe('https://localhost/api/inbox/receive/inbox-token-1');
    expect(result.data.inboxReceiveSecret).toBe('inbox-secret-1');
  });

  it('preserves existing feed tokens when appending a token', async () => {
    const existing = [{ name: 'Primary', token: 'feed-token-1' }];
    mocks.query
      .mockResolvedValueOnce({ rows: [{ calendar_feed_tokens: existing }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await calendarImport.request('/feed-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Secondary' }),
    });

    expect(response.status).toBe(200);
    expect(String(mocks.query.mock.calls[1][0])).toContain('calendar_feed_tokens = $1::jsonb');
    const stored = JSON.parse(mocks.query.mock.calls[1][1][0] as string);
    expect(stored).toHaveLength(2);
    expect(stored[0]).toEqual(existing[0]);
    expect(stored[1].name).toBe('Secondary');
    expect(stored[1].token).toMatch(/^[0-9a-f]{48}$/);
  });

  it('treats malformed stored token JSON as an empty list instead of failing', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ calendar_feed_tokens: '{broken' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await calendarImport.request('/feed-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Secondary' }),
    });

    expect(response.status).toBe(200);
    const stored = JSON.parse(mocks.query.mock.calls[1][1][0] as string);
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('Secondary');
  });

  it('truncates over-limit source lists to five instead of rejecting', async () => {
    const externalCalendarUrls = Array.from(
      { length: 6 },
      (_, index) => `https://calendar${index}.example/events.ics`,
    );

    const response = await calendarImport.request('/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ externalCalendarUrls, externalCalendarSyncStrategy: 'replace' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO user_configs');
    const storedUrls = JSON.parse(params[1] as string);
    expect(storedUrls).toHaveLength(5);
    expect(storedUrls[0]).toBe('https://calendar0.example/events.ics');
    expect(params[2]).toBe('replace');
  });
});

describe('import-ics upload', () => {
  it.each([
    ['an empty body', ''],
    ['an oversized body', 'x'.repeat(2_000_001)],
  ])('rejects %s', async (_caseName, body) => {
    const response = await calendarImport.request('/import-ics', {
      method: 'POST',
      headers: { 'Content-Type': 'text/calendar' },
      body,
    });

    expect(response.status).toBe(400);
    const result = await response.json() as any;
    expect(result.error).toBe('ICS 文件过大或为空');
    expect(mocks.createEvent).not.toHaveBeenCalled();
  });

  it('rejects an ICS body without parseable events', async () => {
    const response = await calendarImport.request('/import-ics', {
      method: 'POST',
      headers: { 'Content-Type': 'text/calendar' },
      body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR',
    });

    expect(response.status).toBe(400);
    const result = await response.json() as any;
    expect(result.error).toBe('未解析到有效事件');
    expect(mocks.createEvent).not.toHaveBeenCalled();
  });

  it('imports parsed events with the default reminder config', async () => {
    const body = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'SUMMARY:First',
      'DTSTART;VALUE=DATE:20261001',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'SUMMARY:Second',
      'DTSTART;VALUE=DATE:20261002',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const response = await calendarImport.request('/import-ics', {
      method: 'POST',
      headers: { 'Content-Type': 'text/calendar' },
      body,
    });

    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.data).toEqual({ imported: 2, total: 2, errors: [] });
    expect(mocks.createEvent).toHaveBeenCalledTimes(2);
    const [userId, payload] = mocks.createEvent.mock.calls[0] as [string, { name: string; date: string; reminderConfig: Record<string, unknown> }];
    expect(userId).toBe('7');
    expect(payload).toMatchObject({
      name: 'First',
      date: '2026-10-01',
      calendarType: 'gregorian',
      reminderConfig: { enabled: true, daysBeforeList: [1, 3, 7] },
    });
  });

  it('records failed imports in errors without aborting the batch', async () => {
    mocks.createEvent
      .mockResolvedValueOnce({ id: 1 })
      .mockRejectedValueOnce(new Error('db down'));

    const body = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'SUMMARY:First',
      'DTSTART;VALUE=DATE:20261001',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'SUMMARY:Second',
      'DTSTART;VALUE=DATE:20261002',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const response = await calendarImport.request('/import-ics', {
      method: 'POST',
      headers: { 'Content-Type': 'text/calendar' },
      body,
    });

    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.data).toEqual({ imported: 1, total: 2, errors: ['Second'] });
  });
});
