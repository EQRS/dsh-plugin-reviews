'use client';

/**
 * 手机端首页的滚动加载哨兵。
 *
 * 为什么这么做：手机端不再用「展开/收起」，内容一直向下滚（主人要求）。列表条数由服务端
 * 按 URL 参数 `rv` / `pv` 控制；哨兵进入视口附近时把参数调大，`router.replace(..., { scroll: false })`
 * 让服务端多渲染一批，滚动位置保持不变 —— 这样首屏只传默认条数，后面按需加载。
 *
 * 桌面端（>900px）不渲染哨兵：桌面仍走「一屏 + 展开」，条数保持默认。
 * 已经取完（value >= total）时也不渲染。
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/** 与 globals.css 的移动端断点一致。 */
const MOBILE_QUERY = '(max-width: 900px)';

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
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const apply = () => setMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // 新数据到位（value 变了）后，才允许下一次触发。
  useEffect(() => {
    pending.current = false;
  }, [value]);

  useEffect(() => {
    if (!mobile || value >= total) return;
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || pending.current) return;
        pending.current = true;
        const next = Math.min(value + step, total);
        const url = new URL(window.location.href);
        url.searchParams.set(param, String(next));
        router.replace(url.pathname + url.search + url.hash, { scroll: false });
      },
      // 提前 600px 预取，滚到底之前就已经就绪。
      { rootMargin: '600px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [mobile, value, step, total, param, router]);

  if (!mobile || value >= total) return null;
  return <div ref={ref} className="load-more-sentinel" aria-hidden="true" />;
}
