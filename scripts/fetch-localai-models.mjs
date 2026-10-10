#!/usr/bin/env node
/**
 * 拉取 LocalAI 浏览器推理的模型权重（~260MB 二进制不入库，见 .gitignore）。
 * 用法：node scripts/fetch-localai-models.mjs
 * 来源 = vercel 仓库同款文件的 HuggingFace 官方地址；本地路径与 vercel 完全一致，
 * 保证 /models/ URL 与前端代码的期望不变。已存在的文件跳过（幂等）。
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

// [本地相对路径, 远端 URL]。参数分片来自 mlc-ai 官方仓库（与 tensor-cache.json 的
// records[].dataPath 一致）；MiniLM ONNX 来自 Xenova 官方仓库。
const FILES = [
  ['frontend/public/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx',
   'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx'],
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => [
    `frontend/public/models/mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC/resolve/main/params_shard_${i}.bin`,
    `https://huggingface.co/mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC/resolve/main/params_shard_${i}.bin`,
  ]),
];

const ROOT = path.resolve(import.meta.dirname ?? '.', '..');

let skipped = 0;
let failed = 0;
for (const [rel, url] of FILES) {
  const dest = path.join(ROOT, rel);
  if (existsSync(dest) && statSync(dest).size > 0) {
    skipped++;
    console.log(`skip  ${rel} (${(statSync(dest).size / 1024 / 1024).toFixed(1)}MB)`);
    continue;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.download`;
  console.log(`fetch ${rel} ...`);
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await pipeline(res.body, createWriteStream(tmp));
    await rename(tmp, dest);
    console.log(`  ok   (${(statSync(dest).size / 1024 / 1024).toFixed(1)}MB)`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${err.message}`);
    await unlink(tmp).catch(() => {});
  }
}

console.log(`done: ${FILES.length - skipped - failed} fetched, ${skipped} skipped, ${failed} failed`);
if (failed > 0) {
  console.error('重跑本脚本可续传（已完成的文件会跳过）。网络不通时可设 HF_ENDPOINT=https://hf-mirror.com');
  process.exit(1);
}
