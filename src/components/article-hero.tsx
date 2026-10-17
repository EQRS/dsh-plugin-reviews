/**
 * 文章头图（设计感由代码生成，不用位图资源）。
 *
 * 为什么自己画：本站没有图片素材，也不该为一张装饰图引入二进制资源与网络请求。
 * 用 SVG 有三个好处——跟随主题令牌变色（深色/换肤自动适配）、任何分辨率都锐利、体积可以忽略。
 *
 * 设计：以 M3 容器色做渐变打底（primary-container → tertiary-container → surface-container-high），
 * 叠一层网格（暗示"结构化资料"）、两枚柔光、几组同心圆与斜线作为几何装饰。
 * 位置与角度由 seed（评测 id）哈希决定 —— 所以**每篇文章的头图都不一样、同一篇每次又完全一致**。
 *
 * 纯服务端组件，无状态、无客户端 JS。
 */

/** 由字符串得到稳定的 0–1 序列（同一 id 永远同一张图）。 */
function hash01(seed: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // 取无符号 32 位后归一化
  return ((h >>> 0) % 10000) / 10000;
}

export function ArticleHero({ seed, className }: { seed: string; className?: string }) {
  const r = (salt: number) => hash01(seed, salt);
  const id = `hero-${seed.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)}`;
  const angle = 12 + Math.round(r(1) * 48);
  const glowX = 0.15 + r(2) * 0.7;
  const glowY = 0.1 + r(3) * 0.6;
  const ringX = 0.62 + r(4) * 0.3;
  const ringY = 0.2 + r(5) * 0.5;
  const ringR = 60 + Math.round(r(6) * 70);
  const slant = 0.55 + r(7) * 0.35;

  return (
    <div className={className ? `article-hero ${className}` : 'article-hero'} aria-hidden="true">
      <svg viewBox="0 0 1200 260" preserveAspectRatio="none" className="article-hero-svg">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1" gradientTransform={`rotate(${angle} 0.5 0.5)`}>
            <stop offset="0%" stopColor="var(--md-sys-color-primary-container)" />
            <stop offset="52%" stopColor="var(--md-sys-color-tertiary-container)" />
            <stop offset="100%" stopColor="var(--md-sys-color-surface-container-high)" />
          </linearGradient>
          <radialGradient id={`${id}-glow`} cx={glowX} cy={glowY} r="0.55">
            <stop offset="0%" stopColor="var(--md-sys-color-primary)" stopOpacity="0.5" />
            <stop offset="100%" stopColor="var(--md-sys-color-primary)" stopOpacity="0" />
          </radialGradient>
          <pattern id={`${id}-grid`} width="34" height="34" patternUnits="userSpaceOnUse">
            <path
              d="M34 0H0V34"
              fill="none"
              stroke="var(--md-sys-color-on-primary-container)"
              strokeOpacity="0.12"
              strokeWidth="1"
            />
          </pattern>
        </defs>

        <rect width="1200" height="260" fill={`url(#${id})`} />
        <rect width="1200" height="260" fill={`url(#${id}-grid)`} />
        <rect width="1200" height="260" fill={`url(#${id}-glow)`} />

        {/* 几何装饰：同心圆 + 斜线束，位置由 seed 决定 */}
        <g
          fill="none"
          stroke="var(--md-sys-color-on-primary-container)"
          strokeOpacity="0.22"
          strokeWidth="1.5"
        >
          <circle cx={ringX * 1200} cy={ringY * 260} r={ringR} />
          <circle cx={ringX * 1200} cy={ringY * 260} r={ringR * 1.7} strokeOpacity="0.12" />
          <circle cx={ringX * 1200} cy={ringY * 260} r={ringR * 2.5} strokeOpacity="0.07" />
          <path
            d={`M${280 * slant} 260 L${280 * slant + 360} 0`}
            strokeOpacity="0.16"
          />
          <path
            d={`M${280 * slant + 44} 260 L${280 * slant + 404} 0`}
            strokeOpacity="0.1"
          />
        </g>

        {/* 底部渐隐：让下方标题层与头图衔接自然 */}
        <rect
          y="150"
          width="1200"
          height="110"
          fill="var(--md-sys-color-surface-container-high)"
          opacity="0.28"
        />
      </svg>
    </div>
  );
}