'use client';

/**
 * 动效运行时（客户端）。
 *
 * 做法参考工作区 `面板\panel\cmd\panel\web\motion.js`，但按本项目的形态重写：
 *   - **入场**：给页面根容器的直接子元素写 `--i` 并按序升起；动画结束（或超时兜底）后**摘掉类**，
 *     否则客户端重渲染会把入场重播一次，看起来像闪屏；
 *   - **行级错峰**：列表（`.item-list`）与表格（`.panel table tbody`）的行按更小的步长错峰；
 *   - **按压涟漪**：pointerdown 时就地插一个 span —— 鼠标与触屏都生效，且不依赖 CSS 的 :active 时序；
 *   - **数字跳变**：`[data-fx-count]` 的文本一变就闪一下（例：未读角标从 0 变 3）；
 *   - **减少动效时一个类都不加**（不只是靠 CSS 兜底）：`prefers-reduced-motion: reduce` 下整段逻辑直接返回。
 *
 * 为什么用 usePathname 作依赖：App Router 里布局只挂载一次，页面切换不会重挂这个组件；
 * 以路径为 key 重跑，才能让"每次进入新页面都有一次入场"，而不是只在首次加载时动。
 */

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/** 减少动效时全程不参与（读一次即可：中途改系统设置的极端情况不值得引入监听）。 */
function prefersReduced(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** 入场的最长时长：子元素数 × 步长 + 自身时长，留一点余量做兜底。 */
function spanOf(count: number, stepMs: number, ownMs = 400): number {
  return ownMs + Math.min(count, 16) * stepMs;
}

export function MotionRuntime() {
  const pathname = usePathname();

  useEffect(() => {
    if (prefersReduced()) return;

    const timers: number[] = [];
    const enterTargets: HTMLElement[] = [];
    const rowsTargets: HTMLElement[] = [];

    /** 写 --i 并加类；到点（或动画结束）摘类。 */
    const play = (node: HTMLElement, cls: string, count: number, stepMs: number) => {
      node.classList.remove(cls);
      void node.offsetWidth; // 若上一次还在跑，这里强制重启
      node.classList.add(cls);
      enterTargets.push(node);
      const t = window.setTimeout(() => node.classList.remove(cls), spanOf(count, stepMs));
      timers.push(t);
      node.addEventListener('animationend', () => node.classList.remove(cls), { once: true });
    };

    /* ---------- 1) 页面入场：页面根容器的直接子元素依次升起 ---------- */
    const main = document.getElementById('main-content');
    if (main) {
      Array.from(main.children).forEach((rootEl) => {
        const kids = Array.from(rootEl.children) as HTMLElement[];
        if (kids.length === 0) return;
        kids.forEach((el, i) => el.style.setProperty('--i', String(i)));
        play(rootEl as HTMLElement, 'fx-enter', kids.length, 45);
      });
    }

    /* ---------- 2) 行级错峰：列表行与表格行 ---------- */
    const rowGroups: HTMLElement[] = [
      ...Array.from(document.querySelectorAll<HTMLElement>('.item-list')),
      ...Array.from(document.querySelectorAll<HTMLElement>('.panel table tbody')),
    ];
    rowGroups.forEach((group) => {
      const rows = Array.from(group.children) as HTMLElement[];
      if (rows.length === 0) return;
      rows.forEach((el, i) => el.style.setProperty('--i', String(i)));
      rowsTargets.push(group);
      // 行级不设超时兜底也没问题：动画是 both + 有限时长，不会一直停在透明
      group.classList.add('fx-rows');
      group.addEventListener('animationend', () => group.classList.remove('fx-rows'), { once: true });
    });

    /* ---------- 3) 按压涟漪 ---------- */
    const RIPPLE_HOST = 'fx-ripple-host';
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      const host = target?.closest<HTMLElement>('button:not(:disabled), .button, .back-link, .icon-btn, .filters a');
      if (!host) return;
      const box = host.getBoundingClientRect();
      const size = Math.max(box.width, box.height) * 2;
      const dot = document.createElement('span');
      dot.className = 'fx-ripple';
      dot.style.width = `${size}px`;
      dot.style.height = `${size}px`;
      dot.style.left = `${event.clientX - box.left - size / 2}px`;
      dot.style.top = `${event.clientY - box.top - size / 2}px`;
      host.classList.add(RIPPLE_HOST);
      host.appendChild(dot);
      dot.addEventListener('animationend', () => dot.remove(), { once: true });
      timers.push(window.setTimeout(() => dot.remove(), 800)); // 动画被打断时的兜底
    };
    document.addEventListener('pointerdown', onPointerDown, { passive: true });

    /* ---------- 4) 数字跳变闪一下 ---------- */
    const flashed = new WeakSet<HTMLElement>();
    const flash = (el: HTMLElement) => {
      if (flashed.has(el)) return;
      flashed.add(el);
      el.classList.add('fx-flash');
      el.addEventListener('animationend', () => {
        el.classList.remove('fx-flash');
        flashed.delete(el);
      }, { once: true });
    };
    const observer = new MutationObserver((records) => {
      records.forEach((record) => {
        const el = (record.target.nodeType === Node.TEXT_NODE ? record.target.parentElement : record.target) as HTMLElement | null;
        if (el?.matches('[data-fx-count]')) flash(el);
      });
    });
    document.querySelectorAll<HTMLElement>('[data-fx-count]').forEach((el) => {
      observer.observe(el, { childList: true, characterData: true, subtree: true });
    });

    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      document.removeEventListener('pointerdown', onPointerDown);
      observer.disconnect();
      enterTargets.forEach((el) => el.classList.remove('fx-enter'));
      rowsTargets.forEach((el) => el.classList.remove('fx-rows'));
    };
  }, [pathname]);

  return null;
}