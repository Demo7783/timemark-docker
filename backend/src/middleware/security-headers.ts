import type { Context, Next } from 'hono';
import { isRequestHttps } from '../utils/client-ip.js';

const ROBOTS_TAG = 'noindex, nofollow, noarchive, nosnippet, noimageai, noai';

export async function securityHeaders(c: Context, next: Next) {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('X-Robots-Tag', ROBOTS_TAG);
  c.header('Cross-Origin-Opener-Policy', 'same-origin');

  const https = isRequestHttps(c);
  // docker 1d0b136：HSTS 只在真实 HTTPS 响应上发送；HTTP LAN/NAS 部署发送 HSTS
  // 反而有害（浏览器记住强制 HTTPS 后直连 IP 不再可用）。
  if (https && (process.env.NODE_ENV === 'production' || process.env.VERCEL)) {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  // CSP 指令 = v2.30 版（新增 wasm-unsafe-eval：LocalAI/WebGPU 浏览器推理需要；
  // worker-src blob:：Web Worker 加载模型）+ docker 的按请求协议门控：
  // upgrade-insecure-requests 仅在 HTTPS 请求下附加，否则纯 HTTP 部署的浏览器会
  // 把子资源强制升级到 https://ip:port 导致连接失败、页面白屏。
  const cspDirectives =
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com; script-src-attr 'none'; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https:; " +
    'frame-src https://challenges.cloudflare.com; object-src \'none\'; base-uri \'self\'; form-action \'self\'; ' +
    "worker-src 'self' blob:";
  const cspReportUri = process.env.CSP_REPORT_URI || '/api/csp-report';
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL || https) {
    let csp = cspDirectives;
    if (https) csp += '; upgrade-insecure-requests';
    csp += `; report-uri ${cspReportUri}`;
    c.header('Content-Security-Policy', csp);
  } else {
    c.header('Content-Security-Policy-Report-Only', `default-src 'self'; report-uri ${cspReportUri}`);
  }

  c.res.headers.delete('X-Powered-By');
  c.res.headers.delete('Server');
}
