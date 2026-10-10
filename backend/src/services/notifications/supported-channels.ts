/**
 * Channels supported on Vercel / cloud serverless (HTTP API only).
 * Plugin channels (WeChat/WhatsApp/QQ QR login, Signal CLI, etc.) are excluded.
 *
 * docker 变基：自托管容器是常驻进程，插件渠道（本地会话/本地 CLI/长连接）在
 * docker 上完全可用——仅 VERCEL 运行时保留 serverless 过滤。9 个 docker 独有
 * 渠道见 channels.config.ts 的 dockerPluginChannels。
 */

import { checkChannelSuitability } from '../../utils/serverless-suitability.js';

export { SERVERLESS_NOTES, checkChannelSuitability } from '../../utils/serverless-suitability.js';

export const UNSUPPORTED_CHANNEL_IDS = new Set([
  // Plugin / QR / local process — not available on serverless
  'wechat_personal',
  'whatsapp',
  'qq_bot',
  'signal',
  'imessage',
  'zalo',
  'clawbot',
  // Long-lived relay connections
  'nostr',
]);

/** serverless 运行时（Vercel 函数）才需要插件渠道过滤；docker 常驻进程不过滤 */
export const IS_SERVERLESS_RUNTIME = !!process.env.VERCEL;

export function isSupportedChannel(channelId: string): boolean {
  if (!IS_SERVERLESS_RUNTIME) return true;
  return checkChannelSuitability(channelId).suitable;
}

export function filterSupportedChannels(channelIds: string[]): string[] {
  return channelIds.filter(isSupportedChannel);
}
