#!/usr/bin/env node
/**
 * GitHub Git Data API push fallback（github.com:443 被断时用 gh 的 api.github.com 通道）。
 * 用法：node scripts/push-via-api.mjs [remoteRef=refs/heads/master]
 * 原理：为每个未推送提交上传 blobs → 以远端父树为 base 建树 → 建提交 → 更新引用；
 * 然后 git fetch 对齐本远端跟踪分支，本地按远端 SHA 重建以保证一致。
 * （自 timemark-vercel v2.30 定稿版同步，仓库无关。）
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ref = process.argv[2] || 'refs/heads/master';
const repoFull = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' })
  .trim()
  .replace(/^https:\/\/github\.com\//, '')
  .replace(/\.git$/, '');
const REPO = repoFull; // e.g. WXFffff666/timemark-docker

const gh = (args, input) => {
  try {
    return execFileSync('gh', ['api', ...args, ...(input !== undefined ? ['--input', '-'] : [])], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      input,
    });
  } catch (err) {
    console.error('gh api failed:', err.stderr?.toString() || err.message);
    process.exit(1);
  }
};
const api = (path, input, method) => {
  const args = method ? ['-X', method, path] : [path];
  return JSON.parse(gh(args, input));
};

const BIG_BUFFER = 512 * 1024 * 1024; // 新增字体子集等 blob >1MB，execFileSync 默认 1MB 会 ENOBUFS

// 循环里会随 ref 推进而更新（const 会 crash 在多提交推送的收尾）
let remoteCommitSha = api(`/repos/${REPO}/git/${ref}`).object.sha;
const remoteCommit = api(`/repos/${REPO}/git/commits/${remoteCommitSha}`);
const remoteTree = remoteCommit.tree.sha;

// 内容同步点：本地最新一个"树与远端一致"的提交。GitHub 会规范化提交元数据
// （SHAs 与本地不同但树相同），所以不能按 commit 可达性算未推送集，要按树。
let syncPoint = null;
const localLog = execFileSync('git', ['log', '--format=%H %T', '-300'], { encoding: 'utf8', maxBuffer: BIG_BUFFER }).trim().split('\n');
for (const line of localLog) {
  const [sha, tree] = line.split(' ');
  if (tree === remoteTree) {
    syncPoint = sha;
    break;
  }
}

const unpushed =
  syncPoint === null
    ? [execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', maxBuffer: BIG_BUFFER }).trim()]
    : execFileSync('git', ['log', '--reverse', '--format=%H', `${syncPoint}..HEAD`], { encoding: 'utf8', maxBuffer: BIG_BUFFER })
        .trim()
        .split('\n')
        .filter(Boolean);

if (unpushed.length === 0) {
  console.log(' trees identical — everything already on remote');
  process.exit(0);
}
console.log('remote head:', remoteCommitSha, '| sync point:', syncPoint?.slice(0, 7) ?? 'none (full snapshot)');
console.log('unpushed commits:', unpushed.length);

for (const sha of unpushed) {
  // 1. 差异文件列表（无 rename 拆分：删除=sha:null，新增/修改=新 blob）
  const diffRaw = execFileSync(
    'git',
    ['diff-tree', '-r', '--no-renames', '--diff-filter=AMDR', '--format=', sha],
    { encoding: 'buffer', maxBuffer: BIG_BUFFER },
  ).toString('utf8');

  const treeEntries = [];
  const parentSha = execFileSync('git', ['log', '-1', '--format=%P', sha], { encoding: 'utf8', maxBuffer: BIG_BUFFER }).trim();

  for (const line of diffRaw.split('\n').filter(Boolean)) {
    const [meta, ...pathParts] = line.split('\t');
    const path = pathParts.join('\t');
    const metaParts = meta.split(' '); // [':oldMode', newMode, oldSha, newSha, status]
    const oldMode = metaParts[0].slice(1);
    const newMode = metaParts[1];
    const oldSha = metaParts[2];
    const newSha = metaParts[3];
    const deleted = newSha.replace(/^0+$/, '') === '';
    if (deleted) {
      treeEntries.push({ path, mode: oldMode, type: 'blob', sha: null });
    } else {
      const content = execFileSync('git', ['cat-file', 'blob', newSha], { encoding: 'buffer', maxBuffer: BIG_BUFFER });
      const blob = api('/repos/' + REPO + '/git/blobs', JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }));
      treeEntries.push({ path, mode: newMode, type: 'blob', sha: blob.sha });
    }
  }

  // 2. 以远端当前提交的树为 base 建新树。条目多时（树换装提交 855 条）一次性建树
  //    会服务端超时（HTTP 422 建议增量建树）——按 200 条分块链式 base_tree。
  const CHUNK = 200;
  let baseTree = api(`/repos/${REPO}/git/commits/${remoteCommitSha}`).tree.sha;
  let treeSha = baseTree;
  for (let i = 0; i < treeEntries.length; i += CHUNK) {
    const chunk = treeEntries.slice(i, i + CHUNK);
    const t = api('/repos/' + REPO + '/git/trees', JSON.stringify({ base_tree: baseTree, tree: chunk }));
    treeSha = t.sha;
    baseTree = t.sha;
  }

  // 3. 建提交（GitHub 会规范化 message 与时区——之后本地按远端重建对齐）
  const commitMessage = execFileSync('git', ['log', '-1', '--format=%B', sha], { encoding: 'buffer', maxBuffer: BIG_BUFFER }).toString('utf8');
  const commit = api('/repos/' + REPO + '/git/commits', JSON.stringify({
    message: commitMessage,
    tree: treeSha,
    parents: [remoteCommitSha],
  }));

  // 4. 推进远端引用
  api(`/repos/${REPO}/git/${ref}`, JSON.stringify({ sha: commit.sha, force: false }), 'PATCH');
  console.log(`pushed ${sha.slice(0, 7)} -> ${commit.sha} (${treeEntries.length} files)`);
  remoteCommitSha = commit.sha;
}

console.log('FINAL_REMOTE_SHA=' + remoteCommitSha);
