import { describe, expect, it } from 'vitest';
import { parsePaging } from '../src/app/api/_lib/pagination';

const url = (query = '') => new URL(`https://example.test/comments${query}`);

describe('评论与回复共用分页参数', () => {
  it('默认页码和每页大小不变，也接受显式合法参数', () => {
    expect(parsePaging(url())).toEqual({ page: 1, pageSize: 20 });
    expect(parsePaging(url('?page=2&page_size=50'))).toEqual({ page: 2, pageSize: 50 });
  });

  it('非法页码继续报告 page 字段错误', () => {
    for (const page of ['0', '-1', '1.5', 'invalid']) {
      expect(() => parsePaging(url(`?page=${page}`))).toThrowError(
        expect.objectContaining({ code: 'input_invalid', fields: [{ path: 'page', message: '取值不合法' }] }),
      );
    }
  });

  it('超出允许集合的每页大小继续报告 page_size 字段错误', () => {
    for (const size of ['0', '21', '100', 'invalid']) {
      expect(() => parsePaging(url(`?page_size=${size}`))).toThrowError(
        expect.objectContaining({ code: 'input_invalid', fields: [{ path: 'page_size', message: '取值不合法' }] }),
      );
    }
  });
});
