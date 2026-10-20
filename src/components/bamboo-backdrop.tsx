/**
 * 竹叶感背景装饰（古风高雅 + 轻量叶片飘荡）。
 *
 * 纯 SVG + CSS 动画：不引图片资源、不加 JS 依赖。
 *  - 不再放两角的静态竹枝（主人要求删掉"不会动的静态图片"）；
 *  - 飘落的竹叶：7 片，各走一条慢速弧线下落（20~40 秒/片），到顶淡入、落地淡出；
 *  - 叶片本身是带主脉与侧脉的竹叶形（不是一条灰影），填充跟随主题主色；
 *  - prefers-reduced-motion: reduce 时叶片动画整体关闭（装饰不打扰阅读）。
 *
 * 固定在视口最底层（z-index 0），页面内容（.site-main）抬到 1 之上；
 * pointer-events: none —— 永远不挡点击。
 *
 * 竹叶符号只定义一次（<defs><symbol>），其余 <use> 复用；同一文档内跨 svg 引用成立。
 */
export function BambooBackdrop() {
  return (
    <div className="bamboo-backdrop" aria-hidden="true">
      {/* 竹叶符号：细长、微弯、尖头，带主脉与三条侧脉 —— 缩小后仍像一片叶子 */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <symbol id="bamboo-leaf" viewBox="0 0 32 68">
            <path
              fill="currentColor"
              opacity="0.55"
              d="M17 2 C8 16 4 32 5 47 C5.6 53 7 57 9 59 C15 52 23 37 28 18 C29.5 12 25 5 17 2 Z"
            />
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              opacity="0.9"
              d="M9.5 58 C12 44 15 24 17 4"
            />
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="0.7"
              opacity="0.65"
              d="M12 48 C14.5 46 17.5 44 20.5 42 M12 48 C10 46 8.5 44 7.5 42
                 M13 39 C15.5 37 18.5 35 21.5 33 M13 39 C11 37 9.5 35 8.5 33
                 M14 30 C16.5 28 19.5 26 22.5 24 M14 30 C12 28 10.5 26 9.5 24"
            />
            <path fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.8" d="M9 59 C8 62 7 64.5 6 67" />
          </symbol>
        </defs>
      </svg>

      {/* 飘落竹叶：7 片，CSS 变量 --i 决定起点/节奏/速度 */}
      {Array.from({ length: 7 }).map((_, i) => (
        <span key={i} className="bamboo-leaf" style={{ ['--i' as string]: String(i) }}>
          <svg viewBox="0 0 32 68">
            <use href="#bamboo-leaf" />
          </svg>
        </span>
      ))}
    </div>
  );
}
