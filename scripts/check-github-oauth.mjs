#!/usr/bin/env node
/**
 * GitHub OAuth 凭据体检（部署时用，**不打印任何密钥内容**）。
 *
 *   node scripts/check-github-oauth.mjs
 *
 * 它做三件事：
 *  1. 检查 .env.local / 环境变量里三个必填项是否齐全、形状对不对
 *     （`GITHUB_REDIRECT_URI` 没有默认值，漏了照样算"未配置"）；
 *  2. 算出**该填进 OAuth App 的 callback URL**（必须逐字符一致，所以直接打印出来对照）；
 *  3. 拿一个**故意写错的 code** 去换 token，看 GitHub 怎么回：
 *       - `bad_verification_code`          → 凭据是**对的**（只是 code 是假的）
 *       - `incorrect_client_credentials`   → client_id / secret **不匹配**（或已被重置）
 *     这样能在真登录之前发现问题，不用点进去才发现。
 *
 * 退出码：0 = 可以登录；1 = 还差配置或凭据不对；2 = 出网失败（无法判断，别当成失败）。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REQUIRED = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_REDIRECT_URI'];

function parseEnvFile(path) {
  try {
    const text = readFileSync(path, 'utf8');
    const out = {};
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

const envFile = resolve(process.cwd(), '.env.local');
const fromFile = parseEnvFile(envFile);
const pick = (key) => (fromFile[key] ?? process.env[key] ?? '').trim();

const values = Object.fromEntries(REQUIRED.map((k) => [k, pick(k)]));

console.log('== GitHub OAuth 凭据体检 ==');
console.log(`配置文件：${envFile}`);

let bad = false;
for (const key of REQUIRED) {
  const v = values[key];
  if (!v) {
    console.log(`✗ ${key}  —— 空的（这一项必填）`);
    bad = true;
    continue;
  }
  if (key === 'GITHUB_CLIENT_ID') {
    // 新格式 Ov23li…/Iv23li…；老 App 是 20 位 hex。都不是就当心一点，只提示不拦。
    const ok = /^[A-Za-z0-9]{20}$/.test(v) || /^(Ov|Iv)23li[A-Za-z0-9]{14}$/.test(v);
    console.log(`${ok ? '✓' : '?'} ${key}  —— 已设置，长度 ${v.length}，前缀 ${v.slice(0, 6)}…`);
    if (!ok) console.log('    （形状不像常见的 GitHub client id，自己再核一眼）');
  } else if (key === 'GITHUB_CLIENT_SECRET') {
    const ok = /^[0-9a-f]{40}$/.test(v);
    console.log(`${ok ? '✓' : '?'} ${key}  —— 已设置，长度 ${v.length}`);
    if (!ok) console.log('    （形状不像常见的 40 位 hex client secret，自己再核一眼）');
  } else {
    console.log(`✓ ${key}  —— ${v}`);
  }
}

if (!values.GITHUB_REDIRECT_URI) {
  console.log('\n提示：GITHUB_REDIRECT_URI 没有默认值，必须显式填。');
}

console.log('\n== 该填进 OAuth App 的 callback URL（必须逐字符一致）==');
console.log('  ' + (values.GITHUB_REDIRECT_URI || '(未设置)'));

if (bad) {
  console.log('\n结论：配置还不齐，先补上面标 ✗ 的项。');
  process.exit(1);
}

console.log('\n== 凭据预检（拿一个故意错误的 code 去换 token）==');
let response;
// 用显式 AbortController 而不是 AbortSignal.timeout：后者的计时器无法取消，
// 在本机（Windows + Node 24.12.0）会在 process.exit 那一刻撞 libuv 断言（0xC0000409）。
const ac = new AbortController();
const abortTimer = setTimeout(() => ac.abort(), 30_000);
try {
  response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: values.GITHUB_CLIENT_ID,
      client_secret: values.GITHUB_CLIENT_SECRET,
      code: 'preflight_definitely_invalid_code',
      redirect_uri: values.GITHUB_REDIRECT_URI,
    }),
    signal: ac.signal,
  });
} catch (e) {
  console.log(`出网失败：${e instanceof Error ? e.message : String(e)}`);
  console.log('结论：**无法判断**（这不是"凭据不对"，别误判）。');
  process.exitCode = 2;
} finally {
  clearTimeout(abortTimer);
}

let exitCode = process.exitCode ?? 0;
if (response) {
  const payload = await response.json().catch(() => ({}));
  const code = typeof payload.error === 'string' ? payload.error : '(无 error 字段)';
  console.log(`GitHub 返回：error=${code}`);

  if (code === 'bad_verification_code') {
    console.log('结论：**凭据正确**，可以登录了（这个 error 只是说 code 是假的）。');
    exitCode = 0;
  } else if (code === 'redirect_uri_mismatch') {
    console.log('⚠️ redirect_uri 与 OAuth App 里填的**不一致** —— 去对照上面那行 callback URL。');
    exitCode = 1;
  } else if (code === 'incorrect_client_credentials') {
    console.log('结论：**client_id / client_secret 不匹配**（或 secret 已被重置）。');
    exitCode = 1;
  } else {
    console.log('结论：拿到意料之外的回应，自己看一眼上面那行原文。');
    exitCode = 1;
  }
}

// 不使用 process.exit()：它会在句柄未收敛时直接撕掉进程（本机实测触发 libuv 断言）。
process.exitCode = exitCode;
