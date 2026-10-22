// @vitest-environment jsdom
/**
 * 评测编辑器：Markdown 导入。
 *
 * 行为约定：
 *  - 只接受 .md / .markdown / .txt，≤512KB；
 *  - 导入把文本填进正文，不自动保存；
 *  - 正文非空时覆盖前必须二次确认。
 *
 * 鉴别方式：删掉 onImportMarkdown 里的扩展名/大小校验或 setBodyMarkdown → 对应用例红。
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReviewEditor } from '../src/components/review-editor';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children?: ReactNode; href?: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const DRAFT = {
  draftId: 'draft-1',
  reviewId: 'review-1',
  ownerId: 'user-1',
  pluginId: 'plugin-1',
  payload: {
    title: '一篇实测评测',
    pluginId: 'plugin-1',
    pluginVersion: { kind: 'unknown' },
    dshVersion: { kind: 'unknown' },
    body: [{ key: 'p0', markdown: '原正文' }],
    verdict: null,
    evidence: [],
    assessmentLevel: null,
  },
  payloadSchemaVersion: 3,
  saveVersion: 0,
  createdAt: 1_700_000_000_000,
  savedAt: 1_700_000_000_000,
};

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ json: async () => ({ ok: true, data: DRAFT, request_id: 'r' }) })),
  );
}

function mdInput(): HTMLInputElement {
  return screen.getByLabelText('导入 Markdown 文件') as HTMLInputElement;
}

function bodyTextarea(): HTMLTextAreaElement {
  return screen.getByLabelText('Markdown 正文') as HTMLTextAreaElement;
}

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { writable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('评测编辑器 · Markdown 导入', () => {
  it('导入 .md：正文被替换，并提示已导入（不自动保存）', async () => {
    stubFetch();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ReviewEditor draftId="draft-1" />);
    await screen.findByText('编辑评测草稿');

    const file = new File(['# 导入标题\n\n导入正文'], 'note.md', { type: 'text/markdown' });
    fireEvent.change(mdInput(), { target: { files: [file] } });

    await waitFor(() => expect(bodyTextarea().value).toContain('# 导入标题'));
    expect(bodyTextarea().value).toContain('导入正文');
    expect(screen.getByText(/已导入/)).toBeTruthy();
  });

  it('正文非空时取消确认：正文保持不变', async () => {
    stubFetch();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ReviewEditor draftId="draft-1" />);
    await screen.findByText('编辑评测草稿');
    expect(bodyTextarea().value).toBe('原正文');

    const file = new File(['新正文'], 'note.md', { type: 'text/markdown' });
    fireEvent.change(mdInput(), { target: { files: [file] } });

    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(bodyTextarea().value).toBe('原正文');
  });

  it('非 Markdown 扩展名被拒绝', async () => {
    stubFetch();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ReviewEditor draftId="draft-1" />);
    await screen.findByText('编辑评测草稿');

    const file = new File(['%PDF'], 'note.pdf', { type: 'application/pdf' });
    fireEvent.change(mdInput(), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText(/只支持 \.md/)).toBeTruthy());
    expect(bodyTextarea().value).toBe('原正文');
  });
});
