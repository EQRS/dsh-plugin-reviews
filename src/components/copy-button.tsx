'use client';

/**
 * 通用「复制」按钮（整合包安装命令、配置模板共用）。
 *
 * 纪律：**复制成功后要给可见反馈**，否则用户不知道按没按到；
 * `navigator.clipboard` 在非安全上下文（http）下不可用，退回 `execCommand` 兜底。
 */

import { useState } from 'react';

export function CopyButton({
  text,
  label = '复制',
  copiedLabel = '已复制',
  disabled = false,
  title,
  size = 'sm',
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  disabled?: boolean;
  title?: string;
  size?: 'sm' | 'md';
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      disabled={disabled}
      title={title ?? label}
      style={{
        background: copied ? '#4e7a4e' : 'transparent',
        color: copied ? '#FFFFFF' : 'var(--md-sys-color-primary, #2456B8)',
        border: '1px solid var(--md-sys-color-outline-variant, #DBE1EA)',
        borderRadius: 6,
        padding: size === 'sm' ? '2px 10px' : '6px 14px',
        fontSize: size === 'sm' ? 12 : 14,
        cursor: disabled ? 'not-allowed' : 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {copied ? copiedLabel : label}
    </button>
  );
}
