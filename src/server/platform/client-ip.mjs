/**
 * 真实客户端 IP 解析（纯函数，无依赖）。
 *
 * 为什么单独一个 .mjs：`server.mjs` 是**普通 node 入口**（不是 TS，跑不了类型剥离），
 * 而这段逻辑需要被单测覆盖 —— 放在能被 import 的普通模块里，两边都能用。
 *
 * 为什么这件事值得写清楚：反代后面如果直接取 `x-forwarded-for`，
 * 等于让**客户端自己决定**日志里记的是谁（这个头 HTTP 上谁都能写）。
 * 所以规则只有一条：**只有部署方明确声明"我前面有反代"（DSH_REVIEW_TRUST_PROXY=1）时才读这些头**；
 * 默认只用 TCP 对端地址，那是内核给的、不可伪造。
 */

/**
 * 归一化地址：去掉 IPv6 映射前缀、方括号与端口。
 *
 * 归一化的意义：`::ffff:127.0.0.1` 与 `127.0.0.1` 是同一个来源，
 * 不归一化就会出现"同一个人两条记录"，按 IP 排查时对不上。
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeClientIp(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (value === '') return null;

  if (value.startsWith('[')) {
    // [::1]:443 / [::1]
    const end = value.indexOf(']');
    if (end !== -1) value = value.slice(1, end);
  } else if (value.includes(':') && value.includes('.')) {
    // 形如 127.0.0.1:5555：只有末尾确实是纯数字端口时才切掉。
    // 先判断"含点"是为了不误伤纯 IPv6（2001:db8::1 里没有点）。
    const idx = value.lastIndexOf(':');
    if (/^\d+$/.test(value.slice(idx + 1))) value = value.slice(0, idx);
  }

  if (value.toLowerCase().startsWith('::ffff:')) value = value.slice(7);
  return value === '' ? null : value;
}

/** 取头字段的字符串值（node 对重复头会给数组）。 */
function headerValue(headers, name) {
  const raw = headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : null;
}

/**
 * 解析客户端地址。
 *
 * @param {{ headers?: Record<string, unknown>, socketAddress?: string | null, trustProxy?: boolean }} input
 * @returns {string | null}
 */
export function resolveClientIp({ headers, socketAddress = null, trustProxy = false } = {}) {
  if (trustProxy) {
    // 首选 X-Real-IP：我们自己的 nginx 用 $remote_addr 覆盖它，值权威且只有一个。
    const real = normalizeClientIp(headerValue(headers, 'x-real-ip'));
    if (real) return real;

    // 退路：X-Forwarded-For。本部署里 nginx 也是**覆盖**写入（只有一个值）；
    // 万一前面又多了一层代理，取最左那个 —— 约定是"那一层必须自己负责清洗"。
    const forwarded = headerValue(headers, 'x-forwarded-for');
    if (forwarded) {
      const first = normalizeClientIp(forwarded.split(',')[0] ?? '');
      if (first) return first;
    }
  }

  // 默认路径：TCP 对端地址（反代后面这里会是 nginx 的地址，这正是"没开 TRUST_PROXY"的表现）
  return normalizeClientIp(socketAddress);
}