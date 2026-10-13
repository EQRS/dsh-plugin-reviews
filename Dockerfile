# syntax=docker/dockerfile:1
#
# DSH 插件测评站 · 容器镜像
#
# 一个镜像同时供 web 与 worker 使用（两者共用同一份业务代码、同一个库），
# 由 compose 用不同 command 拉起不同进程 —— 与 systemd 那套的分工完全一致。
#
# 为什么不做 standalone 瘦身：worker 跑的是 TS（tsx），需要 node_modules 与源码。
# 拆成"web 用 standalone、worker 用全量依赖"两个镜像，会让"两边是同一份代码"
# 这个前提变得难以核对，而收益只是镜像小几百 MB。要瘦身得先给 worker 做编译产物，
# 那是另一片的事，不该混进"先把容器跑起来"这一步。

FROM node:24-bookworm-slim AS base
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
# tini：容器里的 1 号进程只负责转发信号 + 回收僵尸进程，SIGTERM 才能真的传到 node
# curl：给 HEALTHCHECK 用
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# ---------- 依赖层 ----------
FROM base AS deps
WORKDIR /app
# better-sqlite3 命中预编译包时用不到这些；没有预编译包时缺了它们 `npm ci` 直接失败
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# 必须显式 --include=dev：上面 NODE_ENV=production，而本项目的 worker（tsx）
# 与构建（typescript）都依赖 devDependencies，少了它们 worker 起不来、build 也会失败。
RUN npm ci --include=dev

# ---------- 构建层 ----------
FROM deps AS builder
COPY tsconfig.json next.config.ts ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
RUN npm run build

# ---------- 运行层 ----------
FROM base AS runner
WORKDIR /app
# 固定 UID/GID（与《依赖与 Linux 部署》一致）；容器内绝不用 root 跑业务
RUN groupadd --gid 10001 dsh \
 && useradd --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin dsh \
 && mkdir -p /app/.data \
 && chown -R 10001:10001 /app

COPY --from=deps    /app/node_modules ./node_modules
COPY --from=builder /app/.next        ./.next
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/tsconfig.json /app/next.config.ts /app/server.mjs ./
COPY --from=builder /app/src        ./src
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/scripts    ./scripts

# 秘密一律由运行时注入（compose env_file），绝不烘进镜像
ENV DSH_REVIEW_DB_PATH=/app/.data/app.sqlite \
    DSH_REVIEW_MEDIA_ROOT=/app/.data/media

USER 10001:10001
EXPOSE 3000

# 存活检查看的是"本进程还能不能服务"：库能查、结构齐全 → 200；结构坏了 → 503。
# **刻意不含 worker 心跳** —— worker 是另一个容器，它挂了不该让 web 被重启。
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

# 用自定义 server（server.mjs）而不是 `next start`：
# 只有它能在生产下打出**每请求一行、含状态码与耗时**的访问日志
# （Next 自带的 incomingRequests 日志只在 dev 生效，实测生产下不出一行）。
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.mjs"]
