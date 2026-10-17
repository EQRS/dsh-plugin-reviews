/** 评论与回复共用分页校验；普通工具函数不能从 Next 路由入口导出。 */
import { err } from '@/packages/common/errors';
import { PaginationDefaults } from '@/packages/common/result';

export function parsePaging(url: URL): { page: number; pageSize: number } {
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('page_size') ?? String(PaginationDefaults.default_page_size));
  if (!Number.isInteger(page) || page < 1) {
    throw err.input('页码必须是从 1 开始的正整数。', [{ path: 'page', message: '取值不合法' }]);
  }
  if (!(PaginationDefaults.allowed_page_sizes as readonly number[]).includes(pageSize)) {
    throw err.input(`每页条数只允许 ${PaginationDefaults.allowed_page_sizes.join('、')}。`, [
      { path: 'page_size', message: '取值不合法' },
    ]);
  }
  return { page, pageSize };
}
