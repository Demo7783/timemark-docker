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

/**
 * serverless 运行时（Vercel 函数）才需要插件渠道过滤；docker 常驻进程不过滤。
 * 每次调用动态读取（模块加载期取值会让测试无法切换运行时语义）。
 */
export function isServerlessRuntime(): boolean {
  return !!process.env.VERCEL;
}

export function isSupportedChannel(channelId: string): boolean {
  if (!isServerlessRuntime()) return true;
  return checkChannelSuitability(channelId).suitable;
}

export function filterSupportedChannels(channelIds: string[]): string[] {
  return channelIds.filter(isSupportedChannel);
}
