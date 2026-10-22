// @vitest-environment jsdom
/**
 * 撤回按钮：仅撤回 / 撤回并删除草稿。
 *
 * 鉴别方式：把 submit 的 deleteDraft 参数写死为 false → 第二条用例红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WithdrawButton } from '../src/components/withdraw-button';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

interface Call {
  url: string;
  body: string | null;
}

function stubFetch(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return {
        json: async () => ({
          ok: true,
          data: { withdrawnAt: 1, draftDeleted: true },
          request_id: 'r',
        }),
      };
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('撤回按钮 · 仅撤回 / 撤回并删除草稿', () => {
  it('仅撤回：请求体 deleteDraft=false，提示草稿保留', async () => {
    const calls = stubFetch();
    render(<WithdrawButton reviewId="review-1" expectedControlVersion={1} />);

    fireEvent.click(screen.getByRole('button', { name: '撤回这篇评测' }));
    fireEvent.click(screen.getByRole('button', { name: '仅撤回（保留草稿）' }));

    await waitFor(() => expect(screen.getByText(/草稿还在草稿区/)).toBeTruthy());
    const body = JSON.parse(calls[0].body ?? '{}') as { deleteDraft?: boolean };
    expect(body.deleteDraft).toBe(false);
  });

  it('撤回并删除草稿：请求体 deleteDraft=true，提示草稿已删除', async () => {
    const calls = stubFetch();
    render(<WithdrawButton reviewId="review-1" expectedControlVersion={1} />);

    fireEvent.click(screen.getByRole('button', { name: '撤回这篇评测' }));
    fireEvent.click(screen.getByRole('button', { name: '撤回并删除草稿' }));

    await waitFor(() => expect(screen.getByText(/已撤回并删除草稿/)).toBeTruthy());
    const body = JSON.parse(calls[0].body ?? '{}') as { deleteDraft?: boolean };
    expect(body.deleteDraft).toBe(true);
  });
});
