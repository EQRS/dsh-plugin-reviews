'use client';

/**
 * 页码跳转：双击「当前页 / 总页数」变成输入框，回车跳到目标页。
 *
 * 为什么不用一直点「下一页」：页数多时翻到中间很累（主人要求）。
 * 双击进入编辑；回车提交、Esc 或失焦取消；键盘聚焦后按 Enter/空格也能进入编辑。
 *
 * 链接由服务端给一个带 `__PAGE__` 占位符的模板（保留当前筛选条件），
 * 客户端只替换页码，不重新拼查询串。
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/** 占位符不能用 `{page}`：URLSearchParams 会把花括号编码成 %7B%7D。 */
const PAGE_PLACEHOLDER = '__PAGE__';

export function PageJump({
  page,
  totalPages,
  hrefTemplate,
}: {
  page: number;
  totalPages: number;
  /** 站内路径，含 `__PAGE__` 占位符；例如 `/reviews?q=x&page=__PAGE__` */
  hrefTemplate: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(page));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    setDraft(String(page));
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [editing, page]);

  const begin = () => setEditing(true);

  const commit = () => {
    const parsed = Number.parseInt(draft, 10);
    const target = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), totalPages) : page;
    setEditing(false);
    if (target !== page) {
      router.push(hrefTemplate.replace(PAGE_PLACEHOLDER, String(target)));
    }
  };

  if (editing) {
    return (
      <span className="page-now">
        <input
          ref={inputRef}
          className="page-jump-input"
          type="number"
          inputMode="numeric"
          min={1}
          max={totalPages}
          value={draft}
          aria-label={`跳转到页码，1 到 ${totalPages}`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setEditing(false);
            }
          }}
          onBlur={() => setEditing(false)}
        />
        <span> / {totalPages}</span>
      </span>
    );
  }

  return (
    <span
      className="page-now page-jump-trigger"
      role="button"
      tabIndex={0}
      title="双击输入页码"
      onDoubleClick={begin}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          begin();
        }
      }}
    >
      {page} / {totalPages}
    </span>
  );
}
