'use client';

/**
 * 首页双栏容器 + 手机端栏目切换。
 *
 * 桌面（>900px）：两栏同时展示，切换按钮由 CSS 隐藏，行为与以前一致。
 * 手机（≤900px）：TAG 下面右侧出现「最新评测 / 最新插件」分段按钮；
 * 点一下滑块平滑滑到另一侧，栏目内容也横向滑入（第一次点击后才启用入场动画，
 * 首屏不闪）。每个栏目固定展示 10 条，底部按钮跳到对应列表页。
 */

import { useState, type ReactNode } from 'react';

type View = 'reviews' | 'plugins';

export function HomeFeed({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>('reviews');
  const [touched, setTouched] = useState(false);

  const select = (next: View) => {
    setTouched(true);
    setView(next);
  };

  return (
    <div className="home-feed-wrap">
      {/* 仅手机端渲染可见：TAG 下方、右对齐 */}
      <div className="home-view-switch" role="group" aria-label="首页栏目切换">
        <span className={`home-view-thumb${view === 'plugins' ? ' is-right' : ''}`} aria-hidden="true" />
        <button type="button" aria-pressed={view === 'reviews'} onClick={() => select('reviews')}>
          最新评测
        </button>
        <button type="button" aria-pressed={view === 'plugins'} onClick={() => select('plugins')}>
          最新插件
        </button>
      </div>

      <div className="home-feed" id="home-feed">
        <div className="twocol" data-view={view} data-touched={touched ? 'true' : 'false'}>
          {children}
        </div>
      </div>
    </div>
  );
}
