'use client';

/**
 * 首页滚动加载哨兵（桌面 + 手机同一套）。
 *
 * 为什么这么做：首页不再用「一屏 + 展开全部」，内容一直向下滚。列表条数由服务端
 * 按 URL 参数 `rv` / `pv` 控制；哨兵进入视口附近时把参数调大，`router.replace(..., { scroll: false })`
 * 让服务端多渲染一批，滚动位置保持不变 —— 首屏只传默认条数，后面按需加载。
 *
 * 已经取完（value >= total）时也不渲染。
 */

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 同一页上可能有两个哨兵（评测 rv / 插件 pv）同时进入视口。
 * 如果各自立刻 `router.replace`，后一次导航会把前一次的参数覆盖掉（实测：
 * rv 从 24 涨到 34 的同时 pv 的 18 被吞掉，且 pv 的 pending 永远不释放）。
 * 因此把 60ms 内的请求合并成一次导航，两个参数一起写进 URL。
 */
const queued = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function LoadMore({
  param,
  value,
  step,
  total,
}: {
  /** URL 参数名：评测用 rv、插件用 pv。 */
  param: string;
  /** 当前已请求的条数。 */
  value: number;
  /** 每次追加多少条。 */
  step: number;
  /** 服务端统计的可加载总数。 */
  total: number;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const pending = useRef(false);

  // 新数据到位（value 变了）后，才允许下一次触发。
  useEffect(() => {
    pending.current = false;
  }, [value]);

  useEffect(() => {
    if (value >= total) return;
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || pending.current) return;
        pending.current = true;
        queued.set(param, Math.min(value + step, total));
        if (flushTimer !== null) return;
        flushTimer = setTimeout(() => {
          flushTimer = null;
          const url = new URL(window.location.href);
          for (const [key, next] of queued) {
            url.searchParams.set(key, String(next));
          }
          queued.clear();
          router.replace(url.pathname + url.search + url.hash, { scroll: false });
        }, 60);
      },
      // 提前 600px 预取，滚到底之前就已经就绪。
      { rootMargin: '600px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [value, step, total, param, router]);

  if (value >= total) return null;
  return <div ref={ref} className="load-more-sentinel" aria-hidden="true" />;
}
