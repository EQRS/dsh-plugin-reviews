# 部署到 Linux（VPS）

> 2026-10-13 首次真实部署。**本文只写做过的、验证过的步骤**，没验证的地方会明说。

## 当前线上状态（2026-10-13 22:0x 实测，部署 `94a0e2b` + 心跳修正）

| 项 | 值 |
|---|---|
| 地址 | **http://5.231.26.36**（德国 · GHOSTnet，Debian 13，4C/12G/118G） |
| 线上 OAuth App | `dsh-plugin-review-test`（**注意名字里是 test，但它就是线上那个**）；本地那个叫 `dsh-plugin-review-dev` |
| 回调 | `http://5.231.26.36/api/auth/github/callback` |
| 首个管理员 | `icelily` / `01a13531-b77f-7162-8c1f-2f796c2ccab1`（GitHub `liceses` / `121547321`） |
| 数据库 | 目录仍是空库（0 个插件）；实测登录后 `users=1`、`external_identities=1`、`role=admin`；schema 已到 **0006_rate_limiter.sql** |
| 状态 | web + worker 都 active，`enable` 过（重启自动起） |
| Web 入口 | **`node server.mjs`**（自定义 server）—— 带访问日志；`PORT=80`、`DSH_REVIEW_HOST=0.0.0.0` 由单元里的 `Environment=` 给 |
| 健康检查 | `GET /api/health` → 200 `status:ok`，`schema_version 0006_rate_limiter.sql`；`?worker=1` 也 200（worker 心跳新鲜） |
| 可观测性 | 访问日志 `http_request`（状态码/耗时/request_id）、启动自检、worker 心跳、中文错误页与 404 **均已生效** |
| 插件目录 | 搜索 / 用途标签 / 是否有评测 / 排序 / 分页 / 两种空状态 **已上线**；空库时显示"目录当前为空"与「提交插件」入口 |
| 请求频控 | 评论变更 **5 次/分/用户**（合并计数）、插件提交检查 **10 次/时/用户**；超限 429 + `retry_after_seconds`；幂等重放不占额度。**线上只验到"迁移到位 + 表存在"**：线上生产环境关掉了测试登录通道，跑不了那条"打满 6 次拿 429"的 HTTP 验收（本机 dev 上 12/12） |
| 依赖 | 显式声明了 `sharp`（原先只靠 `next` 的可选依赖活着）；删掉了零引用的 `zod` / `drizzle-orm` —— 线上 `npm install` 后确认 `require('sharp')` 在 Linux 上可加载 |

**外部验收（从本机对公网地址发真请求）**：`DSH_ACCEPTANCE_BASE=http://5.231.26.36 node scripts/acceptance-catalog-browse.mjs`
→ **9 通过 / 1 跳过 / 0 失败**（跳过的是"越界页"，空目录下与空状态无法区分）。

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
| **容器还没在真机上跑过** | `Dockerfile` / `compose.yaml` / 两个健康检查脚本已就绪，**本机没有 Docker**，线上也还没装 —— 下一步就是在 VPS 上 `docker compose up --build` 并验证 |
| HTTPS / 域名 / nginx | 现在只有 `http://<IP>` 直连，会话凭证明文过网（靠 `DSH_REVIEW_INSECURE_COOKIES=1` 才可用）。上 TLS 后**必须**删掉那个变量。证书签发要求域名先指向本机（HTTP-01 走 80），**顺序不能反** |
| 备份 | `.data/app.sqlite` 没有定时备份；SQLite 在线备份要用 `sqlite3 .backup` 或停服复制（含 `-wal`/`-shm`） |
| 防火墙 / SSH 加固 | 机器上 ufw 未装；root 密码登录开着（主人明确说先不动）；应用跑在 `dsh` 用户下，这一层是好的 |
| 迁移到 Postgres | SQLite 单文件够这个切片用；并发写不是它的强项 |

## 容器（Docker Compose）

评审把"真实 Linux 容器构建"列为**必须先验的三个外部假设之一**，所以这一步不能只写 Dockerfile 就完事。

### 形态

- **一个镜像两用**：`web` 与 `worker` 共用同一镜像、同一份业务代码、同一个库，靠 compose 换 `command` 区分进程 —— 与 systemd 那套分工完全一致。
  > 刻意**不做** standalone 瘦身：worker 跑的是 TS（`tsx`），需要 `node_modules` 与源码。拆成两个镜像会让"两边是同一份代码"这个前提难以核对，而收益只是镜像小几百 MB。
- **`migrate` 是一次性服务**：跑完即退，`web`/`worker` 用 `depends_on: service_completed_successfully` 等它 —— 对应"迁移由唯一维护进程执行，web/worker 不抢"这条铁律。
- **容器内固定 UID/GID 10001，绝不用 root 跑业务**；`tini` 做 1 号进程，SIGTERM 才能真的传到 node（worker 的优雅退出依赖它）。
- **日志有上限**：`json-file` + `10m × 3`（journald 会自动轮转，容器默认不会）。

### 可观测性（这一层是"出问题能不能看准"的关键）

| 谁 | 怎么判 | 判据 |
|---|---|---|
| `web` 容器 | `HEALTHCHECK` 打 `/api/health` | 库能查 + 外键开启 + 必需表齐全 → 200；结构坏了 → 503 |
| `worker` 容器 | `node scripts/worker-healthcheck.mjs` | 读 worker 自己写的心跳，超过阈值没更新 → 退出码 1 |
| 人 | `node scripts/diagnose.mjs` | 一屏看全：配置配没配、库结构/大小、数据量、任务队列与最近失败、worker 心跳、磁盘、媒体目录 |
| 出故障时 | 访问日志 + `request_error` 日志 | 每请求一行（状态码/耗时）；未捕获异常一行含 `path`/`digest`/`stack`；用户错误页上显示**同一个 digest** |

**web 容器跑的是 `node server.mjs`，不是 `next start`** —— 因为 Next 自带的
`logging.incomingRequests` **只在 dev 生效**（生产下实测不出一行），而中间件拿不到最终状态码。
自定义 server 才能给出"每请求一行、含状态码与耗时"的访问日志。
systemd 单元（`dsh-review-web.service`）也已指向同一个入口，**下次重启生效**。

一行长这样（`/api/health` 与 `/_next/*` 静音，否则日志会被淹掉）：

```json
{"ts":"...","level":"warn","message":"http_request","request_id":"ec217484-...","method":"GET","path":"/boom-verify","status":500,"duration_ms":81,"slow":false}
```

故障时的排查顺序（本机实测过整条链）：

```bash
# 1) 用户报了一个"编号"（错误页上的 digest）→ 直接定位
journalctl -u dsh-review-web --no-pager | grep '2387506696'
#    或容器：docker compose logs web | grep '2387506696'

# 2) 用访问日志看影响面与耗时
journalctl -u dsh-review-web --no-pager | grep '"status":5' | tail -20

# 3) 一屏看全状态
node scripts/diagnose.mjs
```

> 页面级未捕获异常在浏览器里显示中文错误页 + 编号；`not-found.tsx` 的 404 页也会显示本次 `request_id`。
> 两者都是以前没有的 —— 以前用户看到的是 Next 的英文白页，服务端可能一个字都没有。

> `/api/health` **刻意不含** worker 心跳：worker 是另一个容器，它挂了不该让 web 被重启。
> 要问 worker 就显式加 `?worker=1`（那时返回 503）。公网可见的响应里只有状态与 schema 版本；
> 逐项检查要 `?detail=1` **且** `x-health-token` 等于 `DSH_REVIEW_HEALTH_TOKEN`。

### 真机验证结果（2026-10-13，5.231.26.36）

| 项 | 结果 |
|---|---|
| Docker / Compose | `29.9.0` / `v5.6.0`（Docker 官方 Debian trixie 源装上，`systemctl is-active docker` = active） |
| 镜像 | `dsh-plugin-review:local`，**1.3 GB**（全量依赖，含 worker 需要的 tsx） |
| 构建 | 一次成功：apt → `npm ci --include=dev` → `next build` |
| 容器 | `web` **healthy**（`0.0.0.0:8081->3000`）、`worker` **healthy**、`migrate` 跑完即退 |
| 迁移 | 在容器的**全新库**上跑了全部 4 个（`alreadyApplied: []`），最后停在 `0004_runtime_heartbeats.sql` |
| 行为 | `/api/health` 200 `status:ok`；`?worker=1` 也 200（worker 活着）；`/` `/plugins` `/reviews` `/admin` `/onboarding` 全 200 |
| 心跳 | 容器内 worker 日志：`已开始写运行时心跳 interval_ms:5000 stale_ms:30000`，库里 `runtime_heartbeats` 有行（含 `worker_reference` 与 `pid`） |
| 身份 | 容器内 `uid=10001(dsh) gid=10001(dsh)`，数据文件属主一致 |
| 诊断脚本 | 在容器里能跑，正确报出配置（只报长度）、库结构、数据量、心跳 |

> ⚠️ **那次真机验证的镜像比 `server.mjs` 早**：当时容器里跑的还是 `next start`，
> 所以那一次**没有访问日志**。要拿到访问日志，重新 `docker compose up -d --build` 即可
> （Dockerfile 的 CMD 已改成 `node server.mjs`）。

### 数据目录属主：这条最容易卡住

镜像里固定 `10001:10001`，**但宿主目录的属主常常是别的号** —— 本机线上 `dsh` 是 **989:989**。
实测：以 10001 跑容器，对线上 `.data` **写不进去**（`Permission denied`）；以 989 跑则正常。
所以 compose 三个服务都接受 `DSH_REVIEW_UID` / `DSH_REVIEW_GID` 覆盖：

```bash
# 只读看线上真库（不触发迁移，安全）
DSH_REVIEW_DATA_DIR=./.data DSH_REVIEW_UID=989 DSH_REVIEW_GID=989 \
  docker compose run --rm --no-deps web node scripts/diagnose.mjs
```

**两条路，选一条**：① 让容器跟宿主属主走（`DSH_REVIEW_UID=989 DSH_REVIEW_GID=989`，**不动主人的数据**，systemd 随时能接管）；
② 把 `.data` `chown -R 10001:10001`（更符合"固定 UID"的本意，但 systemd 那套就写不进去了，等于单向门）。

> 上面那次只读验证顺带证明了诊断脚本的价值：它一眼指出**线上库还停在 `0003_auth_media.sql`、缺 `runtime_heartbeats`**。

### 切到 80（把线上换成容器）

```bash
cd /srv/dsh-plugin-review

# 1) 先在新端口起一遍，确认 healthy（已做过）
DSH_REVIEW_WEB_PORT=8081 docker compose up -d --build

# 2) 停 systemd（两套不能同时占 80），再换成 80 端口
systemctl disable --now dsh-review-web dsh-review-worker
DSH_REVIEW_UID=989 DSH_REVIEW_GID=989 DSH_REVIEW_WEB_PORT=80 docker compose up -d

# 3) 复核
docker compose ps
curl -fsS 'http://127.0.0.1/api/health?worker=1'
node scripts/diagnose.mjs

# 想退回 systemd（先停容器再起服务）
docker compose down && systemctl enable --now dsh-review-web dsh-review-worker
```

> ⚠️ 切过去时容器里的 `migrate` 会把线上库升到 `0004`。那是个**只加一张表**的迁移，旧代码不受影响；
> 但"升上去之后再退回旧 systemd 代码"会留下这张多余的表 —— 无害，知道就行。

### 踩过的坑

- `npm ci` 在 `NODE_ENV=production` 下**默认不装 devDependencies**，而本项目的 `tsx`（worker 运行时）与 `typescript`（构建）都在 dev 里 —— 不写 `--include=dev` 会构建失败、worker 起不来。
- 别用 `Start-Process npx`（Windows 上是 .cmd 垫片，报"不是有效的 Win32 应用程序"）；要后台跑就用 `cmd /c npx ...` 或作业层。
- 镜像 1.3 GB：worker 跑 TS 就要全量依赖。要瘦身得先给 worker 做编译产物，那是另一片的事。

## HTTPS 路线（域名一旦指向本机就能做）

1. 装 **Caddy**（自动申请 + 续签 Let's Encrypt，比 nginx+certbot 少一半配置）
2. Web 退到 `127.0.0.1:3000`，Caddy 占 80/443 反代；顺手把单元里的 `CAP_NET_BIND_SERVICE` 删掉
3. **删掉 `.env.local` 里的 `DSH_REVIEW_INSECURE_COOKIES=1`** —— 会话 Cookie 回到 `__Host-` + `Secure`
4. OAuth 回调改成 `https://<域名>/api/auth/github/callback`（在对应的 App 页面改，或再建一个）
5. 验证：证书链、`__Host-dsh_session` 是否真的落下、完整登录 → onboarding → 管理员
