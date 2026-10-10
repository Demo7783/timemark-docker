/** Shared CORS / CSRF origin rules — v2.30 调用面 + docker 加固语义合并版 */

export const CANONICAL_ORIGIN = 'https://timemark.the37777777.top';

/**
 * docker 加固（v2.16 起保留）：凭据 CORS（Cookie 随响应）不能授权通配符来源。
 * 含 `*` 的条目、带路径/查询/凭据的 URL 一律清洗掉；列表里不存在任何形式的
 * 通配符，下游匹配器天然不会放行子域通配。
 */
function normalizeHttpOrigin(value: string): string | null {
  if (value.includes('*')) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function getConfiguredOrigins(): string[] {
  const origins: string[] = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ];

  const corsOrigin = process.env.CORS_ORIGIN;
  if (corsOrigin) {
    origins.push(
      ...corsOrigin.split(',')
        .map((origin) => normalizeHttpOrigin(origin.trim()))
        .filter((origin): origin is string => origin !== null),
    );
  }

  // docker/NAS 默认只信任本地回环 + 与请求 Host 完全一致（originMatchesHost 覆盖
  // LAN 访问）；不再把作者个人域名硬编码进所有部署的默认允许列表。需要额外公网
  // 来源时通过 CORS_ORIGIN 显式配置。

  return [...new Set(origins)];
}

// 别名：docker 历史命名兼容
export const getAllowedOrigins = getConfiguredOrigins;

export function isVercelAppOrigin(origin: string): boolean {
  return /^https:\/\/[\w-]+\.vercel\.app$/.test(origin);
}

/** LAN 同 Host 访问：Origin 的 host 与请求 Host 完全一致（scheme/port 均在 host 内） */
export function originMatchesHost(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  const normalized = normalizeHttpOrigin(origin);
  if (!normalized) return false;
  try {
    return new URL(normalized).host === host;
  } catch {
    return false;
  }
}

/**
 * docker 加固（v2.16 起保留）：同源判定要求 scheme+host+port 全部一致。
 * requestOrigin 由请求元数据（X-Forwarded-Proto / socket.encrypted / Host）构建。
 */
export function originMatchesRequest(
  origin: string,
  requestOrigin: string | undefined,
): boolean {
  if (!requestOrigin) return false;
  const normalizedOrigin = normalizeHttpOrigin(origin);
  const normalizedRequestOrigin = normalizeHttpOrigin(requestOrigin);
  return normalizedOrigin !== null && normalizedOrigin === normalizedRequestOrigin;
}

/**
 * 第二参数双语义兼容：v2.30 调用方（csrf.ts）传裸 Host；docker 旧调用方
 * （app.ts / 测试）传完整请求 Origin（含 scheme）。按内容自动区分——
 * 完整 Origin 走 scheme+host+port 全匹配，裸 Host 走 host 匹配。
 */
export function isAllowedOrigin(
  origin: string | undefined,
  requestOriginOrHost: string | undefined,
  allowedOrigins: string[],
): boolean {
  if (!origin) return false;
  // 防御性：清洗后的列表理论上不会出现 `*`，出现即拒绝（凭据 CORS 不允许全放行）
  if (allowedOrigins.includes('*')) return false;
  const normalizedOrigin = normalizeHttpOrigin(origin);
  if (!normalizedOrigin) return false;
  if (process.env.ALLOW_VERCEL_PREVIEW === 'true' && isVercelAppOrigin(origin)) return true;
  const sameAuthority = requestOriginOrHost
    ? (requestOriginOrHost.includes('://')
        ? originMatchesRequest(origin, requestOriginOrHost)
        : originMatchesHost(origin, requestOriginOrHost))
    : false;
  if (sameAuthority) return true;
  return allowedOrigins.includes(normalizedOrigin);
}

export function resolveSafeAppOrigin(
  protocol: string | undefined,
  host: string | undefined,
): string {
  const proto = protocol === 'http' ? 'http' : 'https';
  const h = host?.trim();
  if (h) {
    const candidate = `${proto}://${h}`;
    if (isAllowedOrigin(candidate, h, getConfiguredOrigins())) {
      return candidate;
    }
  }
  // 不把作者个人域名作为通用兜底；无法解析时退回本地默认。
  return 'http://localhost:3000';
}

export function resolveCorsOrigin(origin: string | undefined, host: string | undefined): string {
  const allowed = getConfiguredOrigins();
  if (!origin) return allowed[0] ?? 'http://localhost:5173';
  if (isAllowedOrigin(origin, host, allowed)) return origin;
  return allowed[0] ?? 'http://localhost:5173';
}
