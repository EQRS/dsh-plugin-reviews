# 部署到 Linux（VPS）

> 2026-10-13 首次真实部署。**本文只写做过的、验证过的步骤**，没验证的地方会明说。

## 当前线上状态（2026-10-13 20:16 实测）

| 项 | 值 |
|---|---|
| 地址 | **http://5.231.26.36**（德国 · GHOSTnet，Debian 13，4C/12G/118G） |
| 线上 OAuth App | `dsh-plugin-review-test`（**注意名字里是 test，但它就是线上那个**）；本地那个叫 `dsh-plugin-review-dev` |
| 回调 | `http://5.231.26.36/api/auth/github/callback` |
| 首个管理员 | `icelily` / `01a13531-b77f-7162-8c1f-2f796c2ccab1`（GitHub `liceses` / `121547321`） |
| 数据库 | 全新空库；实测登录后 `users=1`、`external_identities=1`、`role=admin` |
| 状态 | web + worker 都 active，`enable` 过（重启自动起） |

**已验证的真实往返**：浏览器点「用 GitHub 登录」→ GitHub 授权页（`dsh-plugin-review-test` wants to access your `liceses` account，仅 read-only）→ 回调落在 `/onboarding?returnTo=/` → 保存昵称 → 导航栏显示「（管理员）」→ `/admin` 可用。

> ✅ 顺带证明了两件事：**全新空库时 `BOOTSTRAP_ADMIN_GITHUB_ID` 真的会生效**（第一次登录即管理员）；
> **生产下测试登录确实关闭**（`testLoginEnabled:false`，导航栏没有那个按钮）。

### 踩到的坑：Client ID 的 `l` 与 `1`

第一次把 client_id 从截图里抄成了 `…TSk1`（数字一），实际是 `…TSkl`（小写 L）。症状很好认：

```
POST https://github.com/login/oauth/access_token  ->  HTTP 404 {"error":"Not Found"}
```

**GitHub 对不认识的 client_id 一律回 404，而不是报错说明**。排查手法：
`node scripts/check-github-oauth.mjs` 拿假 code 去换 token，
回 `bad_verification_code` = 凭据 + 回调**都对**；回 `Not Found` = 这个 client_id 它根本不认识（抄错了/建错了）。
> 抄 client_id / secret 一律**用复制按钮**，不要看图打。

### 观察到的两件事（还不是问题，但要知道）

- **首屏慢**：从国内访问，单个请求 0.7–2.6 秒（SSR + 长距离链路）。可接受但不好看。
- **偶发 chunk 截断**：浏览器控制台出现过一次
  `/_next/static/chunks/…js  net::ERR_INCOMPLETE_CHUNKED_ENCODING`，表现为导航栏一直停在「正在读取登录状态…」；
  硬刷新即恢复。同一文件用 curl 连取 8 次字节数完全一致，说明**不是服务端问题**。
  上 HTTPS 时顺手在前面加一层 nginx/Caddy（`sendfile` + keepalive + gzip）是正解。

## DNS 现状（`lingshulab.com`）

- 根域**没有 A 记录**（NS 在华为云 DNS）；`www` 不存在。
- `review.lingshulab.com` **权威解析指向 `152.175.13.175`（香港 · Sakura）**，不是这台。
  那台 80/443 全关、且同一套 root 口令**认证失败**（进不去）。
- 结论：**域名暂时没用上**，线上先用 IP 访问。以后要上域名，改华为云的 A 记录指到这台，
  再按下面的"HTTPS"章节走一遍。

## 目标形态

```
/srv/dsh-plugin-review          ← 应用（代码 + node_modules + .next + .data）
  ├─ .env.local                 ← 600 权限，只有 dsh 可读
  └─ .data/
       ├─ app.sqlite            ← SQLite（WAL）
       └─ media/                ← 图片原图/展示图
运行用户：dsh（**不是 root**）
两个 systemd 服务：dsh-review-web（:80）、dsh-review-worker
```

- Web 用 `next start -H 0.0.0.0 -p 80`。监听 80 需要特权端口，但**不需要 root**：
  单元里只给了 `CAP_NET_BIND_SERVICE` 这一个能力（`AmbientCapabilities`）。
- **worker 必须一起跑**，否则"提交了却永远不公开"（发布任务没人领）。
- 依赖**包含 devDependencies**：`db:migrate` 与 worker 都通过 `tsx` 直接跑 TypeScript。

## 前置：Node 与工具链

```bash
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq build-essential python3 git ca-certificates xz-utils
cd /tmp
curl -fsSLO https://nodejs.org/dist/v24.12.0/node-v24.12.0-linux-x64.tar.xz
tar -xJf node-v24.12.0-linux-x64.tar.xz -C /usr/local --strip-components=1
rm -f node-v24.12.0-linux-x64.tar.xz
node -v   # v24.12.0（与开发机同版本，避免"本地能跑线上不能"）
```

> 用官方 tarball 而不是 apt/NodeSource：版本可控、与开发机一致。
> `build-essential` + `python3` 是给 `better-sqlite3` 兜底的 —— 实测这台机器
> 直接命中了预编译包（`npm install` 7 秒完成、`require('better-sqlite3')` 可加载）。

## 服务端 `.env.local`

```ini
NODE_ENV=production
DSH_REVIEW_DB_PATH=/srv/dsh-plugin-review/.data/app.sqlite
DSH_REVIEW_MEDIA_ROOT=/srv/dsh-plugin-review/.data/media
# ⚠️ 仅因为当前是 http://<IP> 直连、没有 TLS。上了 HTTPS 立刻删掉这一行。
DSH_REVIEW_INSECURE_COOKIES=1
SESSION_SECRET=<在服务器上生成：head -c 32 /dev/urandom | base64 | tr -d '\n=''>
GITHUB_CLIENT_ID=<线上 OAuth App>
GITHUB_CLIENT_SECRET=<线上 OAuth App>
GITHUB_REDIRECT_URI=http://<IP>/api/auth/github/callback
BOOTSTRAP_ADMIN_GITHUB_ID=<首个管理员的 GitHub 数字 ID>
```

- **不要**设 `DSH_REVIEW_ALLOW_TEST_LOGIN`：生产下它本来也不生效，但留着一个"能凭空造身份"的开关本身就是风险。
- **不要**设 `DSH_REVIEW_CONTENT_SCREEN`：留空 → 提交落 `manual_review`，等人工决定（保守且安全的默认）。
- `chmod 600 .env.local`。

## 步骤

```bash
APP=/srv/dsh-plugin-review
id -u dsh >/dev/null 2>&1 || useradd -r -m -d "$APP" -s /bin/bash dsh
mkdir -p "$APP" && tar -xzf /tmp/dsh-deploy.tar.gz -C "$APP"   # 本地打包上传
cd "$APP"
npm install --no-fund --no-audit          # 不要带 NODE_ENV=production，否则 devDeps 会被跳过
mkdir -p .data/media
chown -R dsh:dsh "$APP"

# 迁移 + 自检 + 构建（都以 dsh 身份跑，免得数据库文件属主变成 root）
su -s /bin/bash dsh -c "cd $APP && set -a && . ./.env.local && set +a && \
  node node_modules/tsx/dist/cli.mjs src/server/platform/migrate-cli.ts && \
  node node_modules/tsx/dist/cli.mjs src/server/platform/selfcheck-cli.ts && \
  node node_modules/next/dist/bin/next build"

cp deploy/dsh-review-*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now dsh-review-web dsh-review-worker
```

## 验证

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/          # 期望 200
curl -s http://127.0.0.1/api/session                                  # 期望 githubLoginConfigured:true
systemctl status dsh-review-web dsh-review-worker --no-pager
journalctl -u dsh-review-worker -n 30 --no-pager                      # worker 要有启动日志
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/api/auth/github/start   # 未配凭据时 503，配好是 302
```

## 更新流程（重新部署）

```bash
# 本地：重新打包（排除 node_modules/.next/.data/.env.local/.git）并上传到 /tmp
tar -czf /tmp/dsh-deploy.tar.gz --exclude=./node_modules --exclude=./.next \
    --exclude=./.data --exclude=./.env.local --exclude=./.git -C <repo> .
# 服务器：
cd /srv/dsh-plugin-review && tar -xzf /tmp/dsh-deploy.tar.gz && npm install
su -s /bin/bash dsh -c "cd /srv/dsh-plugin-review && set -a && . ./.env.local && set +a && \
  node node_modules/tsx/dist/cli.mjs src/server/platform/migrate-cli.ts && \
  node node_modules/next/dist/bin/next build"
systemctl restart dsh-review-web dsh-review-worker
```

> `.env.local` 与 `.data/` **不在包里**，所以更新不会覆盖配置和数据库。

## 还没做（别当成已完成）

| 未做 | 说明 |
|---|---|
| HTTPS / 域名 / nginx | 现在只有 `http://<IP>` 直连，会话凭证明文过网（靠 `DSH_REVIEW_INSECURE_COOKIES=1` 才可用）。上 TLS 后**必须**删掉那个变量。证书签发要求域名先指向本机（HTTP-01 走 80），**顺序不能反** |
| 备份 | `.data/app.sqlite` 没有定时备份；SQLite 在线备份要用 `sqlite3 .backup` 或停服复制（含 `-wal`/`-shm`） |
| 防火墙 / SSH 加固 | 机器上 ufw 未装；root 密码登录开着（主人明确说先不动）；应用跑在 `dsh` 用户下，这一层是好的 |
| 迁移到 Postgres | SQLite 单文件够这个切片用；并发写不是它的强项 |

## HTTPS 路线（域名一旦指向本机就能做）

1. 装 **Caddy**（自动申请 + 续签 Let's Encrypt，比 nginx+certbot 少一半配置）
2. Web 退到 `127.0.0.1:3000`，Caddy 占 80/443 反代；顺手把单元里的 `CAP_NET_BIND_SERVICE` 删掉
3. **删掉 `.env.local` 里的 `DSH_REVIEW_INSECURE_COOKIES=1`** —— 会话 Cookie 回到 `__Host-` + `Secure`
4. OAuth 回调改成 `https://<域名>/api/auth/github/callback`（在对应的 App 页面改，或再建一个）
5. 验证：证书链、`__Host-dsh_session` 是否真的落下、完整登录 → onboarding → 管理员
