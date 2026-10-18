#!/bin/sh
# certbot 续期后：把新证书搬进 nginx 的挂载目录，并让它重新加载。
#
# 为什么需要这一步：certbot.timer 只负责**续期**（更新 /etc/letsencrypt/live/… 里的符号链接），
# 而容器只看到 /root/dsh-plugin-review/certs 这一个目录。少了这个钩子，
# 证书会在某个凌晨静默过期 —— 到期前站点一切正常，到期当天全站证书报错。
#
# 安装：
#   install -m 755 deploy/renew-hook.sh /etc/letsencrypt/renewal-hooks/deploy/dsh-review-nginx.sh
# 手测：
#   certbot renew --dry-run        （会实际触发 deploy hook）
set -eu

DOMAIN="${DSH_REVIEW_TLS_DOMAIN:-review.lingshulab.com}"
DEST="${DSH_REVIEW_CERTS_DIR:-/root/dsh-plugin-review/certs}"
COMPOSE_DIR="${DSH_REVIEW_COMPOSE_DIR:-/root/dsh-plugin-review/repo/docker}"

echo "[renew-hook] 域名=$DOMAIN 目标=$DEST"

install -d -m 755 "$DEST"
install -m 644 "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$DEST/fullchain.pem"
install -m 600 "/etc/letsencrypt/live/$DOMAIN/privkey.pem" "$DEST/privkey.pem"

# 容器里 reload（等价于 nginx -s reload，不中断连接）。
# 容器没在跑时不当作失败：下次 up 会读到新证书。
cd "$COMPOSE_DIR"
if docker compose ps --status running --format '{{.Service}}' 2>/dev/null | grep -qx nginx; then
  docker compose exec -T nginx nginx -t
  docker compose exec -T nginx nginx -s reload
  echo "[renew-hook] 已重载 nginx"
else
  echo "[renew-hook] nginx 未运行，跳过重载（新证书已就位）"
fi
