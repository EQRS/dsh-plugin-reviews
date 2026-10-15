'use client';

/**
 * 阅读进度条（参照站 `网站\HTML\styles.css` 的 .reading-progress-bar）：
 * 顶部 2px 渐变细线，宽度 = 已滚过比例。纯展示，不抢焦点。
 */

import { useEffect, useState } from 'react';

export function ReadingProgress() {
  const [percent, setPercent] = useState(0);

  useEffect(() => {
    const update = () => {
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - window.innerHeight;
      setPercent(scrollable > 0 ? Math.min(100, (window.scrollY / scrollable) * 100) : 0);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return <div className="reading-progress" style={{ width: `${percent}%` }} aria-hidden="true" />;
}