'use client';

/**
 * 首页内容折叠：默认只占「浏览器里的一页」，其余内容点「展开全部」再看。
 *
 * 为什么用 JS 量高度：折叠长度要求是"一页"，而页头 / 英雄区 / 分类行的高度会随视口
 * 与字体加载变化，写死 px 在别的屏幕上不是露出一截就是多留一条空白。
 * 这里量「内容起点 → 视口底部」的距离作为上限，窗口尺寸变化时重新量。
 *
 * 内容本来就没超出一屏时不裁剪、也不渲染按钮（空状态、少量数据时保持原样）。
 * 裁剪用 CSS mask 做底部渐隐，而不是盖一层渐变条：面板背景色与竹叶底纹都能自然透出。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/** 与 globals.css 的移动端断点一致（底部导航只在 ≤900px 出现，折叠时要给它让位）。 */
const MOBILE_QUERY = '(max-width: 900px)';
/** 移动端底部导航高度，与 globals.css 的 --nav-bar-height 保持一致。 */
const NAV_BAR_HEIGHT = 56;
/** 折叠区下方要给「展开全部」按钮留的高度（按钮 40 + 间距 20）。 */
const TOGGLE_HEIGHT = 60;
/** .site-main 的底部内边距：折叠后整页仍要放得下它，否则还会多出一条滚动。 */
const MAIN_PADDING_BOTTOM = 48;
/** 内容再少也至少留这么高，避免在大字体 / 矮视口下只剩一条缝。 */
const MIN_HEIGHT = 360;

export function HomeFeed({ children }: { children: ReactNode }) {
  const feedRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [cap, setCap] = useState<number | null>(null);
  const [overflows, setOverflows] = useState(false);

  const measure = useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    // 元素在文档中的绝对位置：滚动与否都不影响这条测量。
    const top = el.getBoundingClientRect().top + window.scrollY;
    const mobile = window.matchMedia(MOBILE_QUERY).matches;
    const bottomGap =
      (mobile ? NAV_BAR_HEIGHT + 16 : 16) + TOGGLE_HEIGHT + MAIN_PADDING_BOTTOM;
    const available = Math.max(MIN_HEIGHT, Math.round(window.innerHeight - top - bottomGap));
    setCap(available);
    setOverflows(el.scrollHeight > available + 8);
  }, []);

  useEffect(() => {
    measure();
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    // 标题用的是 web font，字体到位后各行高度会变，需要再量一次。
    document.fonts?.ready.then(measure).catch(() => undefined);
    return () => window.removeEventListener('resize', onResize);
  }, [measure]);

  const collapsible = overflows && cap !== null;

  const collapseAndScrollBack = () => {
    const el = feedRef.current;
    if (el) {
      const top = el.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: Math.max(top - 80, 0), behavior: 'smooth' });
    }
    setExpanded(false);
  };

  return (
    <div className="home-feed-wrap">
      <div
        ref={feedRef}
        id="home-feed"
        className={
          expanded ? 'home-feed' : `home-feed is-collapsed${collapsible ? ' is-clipped' : ''}`
        }
        style={!expanded && collapsible && cap !== null ? { maxHeight: cap } : undefined}
      >
        {/* 首页双栏版式在这里落位，页面只负责两栏内容本身。 */}
        <div className="twocol">{children}</div>
      </div>
      {collapsible ? (
        <div className="home-feed-toggle">
          <button
            type="button"
            className="button tonal"
            aria-expanded={expanded}
            aria-controls="home-feed"
            onClick={() => (expanded ? collapseAndScrollBack() : setExpanded(true))}
          >
            {expanded ? '收起' : '展开全部'}
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points={expanded ? '6 15 12 9 18 15' : '6 9 12 15 18 9'} />
            </svg>
          </button>
        </div>
      ) : null}
    </div>
  );
}
