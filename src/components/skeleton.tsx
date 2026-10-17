/**
 * 加载骨架（参照站 `.sk` 的做法：占位块 + 一条横向流光）。
 *
 * 为什么用它替代"正在读取…"这行字：
 *   - 占位块能同时表达"这块正在加载"和"加载完大约占多高"，内容进来时页面不跳；
 *   - **但状态文字不能省**：流光对读屏与"减少动效"用户等于没有信息，
 *     所以这里用 `.sr-only` + `role="status"` 保留可朗读的那句话。
 *
 * 服务端组件（无 hooks），客户端组件里也能直接用。
 */

export function SkeletonLines({ lines = 2, label }: { lines?: number; label?: string }) {
  const widths = ['sk-w70', 'sk-w45', 'sk-w70', 'sk-w35'];
  return (
    <div className="sk-stack" role="status" aria-live="polite">
      <span className="sr-only">{label ?? '正在加载…'}</span>
      {Array.from({ length: Math.max(1, lines) }).map((_, i) => (
        <span key={i} className={`sk sk-md ${widths[i % widths.length]}`} aria-hidden="true" />
      ))}
    </div>
  );
}