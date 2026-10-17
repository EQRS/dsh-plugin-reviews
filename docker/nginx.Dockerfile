# syntax=docker/dockerfile:1
#
# DSH 插件测评站 · 入口镜像（nginx 反代）
#
# 为什么反代配置**烘焙进镜像**而不是挂宿主文件：
# 主人的要求是"除 /root 外不留痕迹"。把 /etc/nginx 的配置留在宿主机上就等于到处撒文件；
# 烘焙进镜像后，宿主机只多一个镜像层，配置变更走"改仓库 + 重新 build"，
# 也顺带保证了"线上跑的配置就是仓库里这份"。
#
# 唯一需要从宿主注入的是 TLS 证书（私钥不该进镜像、也不该进 git），
# 那一个目录挂在 /root 下（见 docs/docker约定.md §TLS）。
#
# 标签说明：默认用 stable-alpine（不会因为某个小版本号消失而构建失败）。
# 生产若要完全可复现，把它改成 `nginx:1.27-alpine@sha256:...` 固定到摘要。

FROM nginx:stable-alpine

# curl 只用于 HEALTHCHECK；alpine 自带 wget 也行，但 curl 的退出码语义更直白
RUN apk add --no-cache curl

# 顶层配置：日志格式（带真实 IP 字段）、gzip、超时、include 站点
COPY nginx/nginx.conf /etc/nginx/nginx.conf
# 站点配置 + 片段。
# 注意：这里会**覆盖**官方镜像自带的 /etc/nginx/conf.d/default.conf（同名），
# 所以不需要额外的 rm —— 镜像里不会残留官方那个默认站点。
COPY nginx/conf.d/ /etc/nginx/conf.d/
COPY nginx/snippets/ /etc/nginx/snippets/

EXPOSE 80 443

# 探针打的是 nginx 自己的 /healthz（由 default.conf 直接 return 200），
# **不依赖 web 容器** —— 上游挂了不该把入口一起判死（同 web 的存活检查口径）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1/healthz || exit 1

# 官方镜像的 ENTRYPOINT/CMD 保持不变（docker-entrypoint.sh + nginx -g daemon off）