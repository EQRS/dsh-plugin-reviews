/** 测试登录开关的唯一判据；生产环境即使显式开启也不允许。 */
export function testLoginAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'production') return false;
  return env.DSH_REVIEW_ALLOW_TEST_LOGIN === '1';
}
