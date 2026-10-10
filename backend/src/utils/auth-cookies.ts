import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { isRequestHttps } from './client-ip.js';
import { SESSION_TTL } from './session-ttl.js';

const ACCESS_COOKIE = 'timemark_access';
const REFRESH_COOKIE = 'timemark_refresh';

// docker 1d0b136：`secure` 按请求协议判定，而不是模块加载期按 NODE_ENV 定死——
// NAS/LAN 明文部署（ALLOW_INSECURE_HTTP=1）时 Secure cookie 会被浏览器直接丢弃，
// 登录陷入「成功但立刻掉线」死循环；反代 TLS 终止场景由 isRequestHttps 读取
// X-Forwarded-Proto 正确判定为 https。
function cookieOpts(c: Context) {
  return {
    httpOnly: true,
    secure: isRequestHttps(c),
    sameSite: 'Lax' as const,
    path: '/',
  };
}

/**
 * Mint the cookie pair for a freshly authenticated session.
 *
 * `accessMaxAgeSeconds` / `refreshMaxAgeSeconds` are explicit numbers rather than a
 * `rememberMe` boolean so a caller can cap the cookie at the server-side deadline
 * (see `sessionTtl.ts`). Passing `undefined` makes that cookie a browser-session
 * cookie, which is the non-remembered mode: MDN notes browsers may restore session
 * cookies after a restart, so the 8h server deadline — not the cookie's disappearance
 * — is what actually ends the session.
 */
export function setAuthCookies(
  c: Context,
  accessToken: string,
  refreshToken: string,
  accessMaxAgeSeconds?: number,
  refreshMaxAgeSeconds?: number,
) {
  const opts = cookieOpts(c);
  setCookie(c, ACCESS_COOKIE, accessToken, {
    ...opts,
    maxAge: accessMaxAgeSeconds,
  });
  setCookie(c, REFRESH_COOKIE, refreshToken, {
    ...opts,
    maxAge: refreshMaxAgeSeconds,
  });
}

export function clearAuthCookies(c: Context) {
  deleteCookie(c, ACCESS_COOKIE, { path: '/' });
  deleteCookie(c, REFRESH_COOKIE, { path: '/' });
}

export function getAccessTokenFromCookie(c: Context): string | undefined {
  return getCookie(c, ACCESS_COOKIE);
}

export function getRefreshTokenFromCookie(c: Context): string | undefined {
  return getCookie(c, REFRESH_COOKIE);
}

export function setAccessCookie(c: Context, accessToken: string, maxAgeSeconds?: number) {
  setCookie(c, ACCESS_COOKIE, accessToken, {
    ...cookieOpts(c),
    maxAge: maxAgeSeconds,
  });
}

export function setRefreshCookie(c: Context, refreshToken: string, maxAgeSeconds?: number) {
  setCookie(c, REFRESH_COOKIE, refreshToken, {
    ...cookieOpts(c),
    maxAge: maxAgeSeconds,
  });
}

/**
 * Access-token lifetime for a session in the given mode. The cookie and the JWT get
 * the same number on purpose: they used to disagree (1h vs 15m), which made one of
 * the two dead config depending on which expired first.
 */
export function accessMaxAgeSeconds(rememberMe: boolean): number {
  return rememberMe ? SESSION_TTL.accessRememberSeconds : SESSION_TTL.accessShortSeconds;
}

/**
 * Refresh-cookie lifetime, capped by the session's own absolute deadline. Without the
 * cap a browser can hold a cookie for a session the server has already ended, so the
 * next request presents a credential that is guaranteed to fail.
 */
export function refreshMaxAgeSeconds(rememberMe: boolean, sessionExpiresAt: Date | string): number {
  const remainingSeconds = Math.floor((new Date(sessionExpiresAt).getTime() - Date.now()) / 1000);
  if (!Number.isFinite(remainingSeconds)) return SESSION_TTL.refreshCookieSeconds;
  const budget = rememberMe ? SESSION_TTL.refreshCookieSeconds : SESSION_TTL.sessionShortSeconds;
  return Math.max(0, Math.min(budget, remainingSeconds));
}
