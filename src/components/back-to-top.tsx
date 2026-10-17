'use client';

/**
 * 回到顶部（长文阅读的常用出口）。
 *
 * 两点与项目纪律一致：
 *  1. **滚过一屏才出现**（不然短页面也挂一个按钮，纯噪音）；
 *  2. `prefers-reduced-motion` 下用瞬时跳转而不是平滑滚动 —— 动效偏好要贯彻到 JS 里，
 *     不能只在 CSS 里关。
 */

import { useEffect, useState } from 'react';

export function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    /**
     * 出现条件：**页面确实能滚**（可滚动高度 > 320px）且读者已经往下看了一段（> 160px）。
     *
     * 为什么不是写死一个像素阈值：实测踩到过 —— 演示文章在 900 高的窗口里最多只能滚 ~400px，
     * 阈值定 600 时按钮永远不出现。用"可滚动高度"参与判断，短文章与长文章都合理：
     * 页面本来就滚不动时，摆一个"回到顶部"是纯噪音。
     */
    const onScroll = () => {
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      setVisible(maxScroll > 320 && window.scrollY > 160);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  if (!visible) return null;

  return (
    <button
      type="button"
      className="back-to-top"
      onClick={() => {
        let reduced = false;
        try {
          reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch {
          reduced = false;
        }
        window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
      }}
    >
      <span aria-hidden="true">↑</span>
      <span>回到顶部</span>
    </button>
  );
}