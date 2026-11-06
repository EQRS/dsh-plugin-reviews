/**
 * 讨论区 · 发帖自动审核（本地规则）。
 *
 * 定位要说清楚：这是**规则**不是内容识别。没有命中就正常发布，命中就把帖子
 * 压成 pending_review 交人工。它只做两件确定的事：
 *
 *   1. 挡掉一眼假的垃圾（大量外链、纯复读、全大写刷屏）；
 *   2. 挡掉明确违禁词（本地词表，可在站点设置里扩展）。
 *
 * 为什么不像内容审核那样「未命中就停人工」：内容实体的审核依赖外部筛查供应商，
 * 没配供应商时分不清"干净"和"没查过"，只能停人工；这里的规则是本地纯函数，
 * 跑完就知道结论，"没命中"是有意义的结论，不该让每篇帖子都去排队。
 *
 * 规则写成纯函数：输入标题与正文，输出结论。不碰数据库，便于穷举测试；
 * 落库（写 forum_post_screenings）由调用方在事务里做。
 */

export interface ScreeningHit {
  rule: string;
  detail: string;
}

export interface ScreeningResult {
  verdict: 'passed' | 'blocked';
  rule: string;
  detail: string;
}

/** 命中时的稳定规则名（写进 forum_post_screenings.rule，便于后台统计）。 */
export const SCREENING_RULES = {
  emptyContent: 'empty_content',
  excessiveLinks: 'excessive_links',
  bannedWord: 'banned_word',
  allCapsTitle: 'all_caps_title',
  repeatedChars: 'repeated_chars',
} as const;

/** 外链条数上限：正常讨论很少超过 3 个链接。 */
const MAX_LINKS = 3;
/** 标题全大写的最小长度：太短的（如 OK）不算刷屏。 */
const ALL_CAPS_MIN = 8;
/** 连续重复同一字符的上限：超过视为刷屏。 */
const MAX_REPEAT = 15;

/**
 * 从正文里数外链条数。
 *
 * 只数 http(s) 与 www 开头的：站内相对链接、Markdown 图片（![]() 已由调用方剥离）
 * 不算垃圾。Markdown 图片单独处理，因为上传的图片必然产生站内或对象存储链接。
 */
function countExternalLinks(text: string): number {
  const withoutImages = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  const matches = withoutImages.match(/https?:\/\/[^\s)）]+|www\.[^\s)）]+/gi);
  return matches ? matches.length : 0;
}

/** 违禁词表：默认给一组明显的，站点可在设置里追加。 */
export const DEFAULT_BANNED_WORDS: readonly string[] = [
  '加微信',
  '代开发票',
  '办证',
  '刷单',
  '博彩',
  '菠菜',
  '色情',
  '约炮',
];

/**
 * 跑一遍规则。
 *
 * @param title 帖子标题
 * @param body  帖子正文（Markdown 原文）
 * @param bannedWords 违禁词（调用方从设置里读，默认 DEFAULT_BANNED_WORDS）
 */
export function screenPost(input: {
  title: string;
  body: string;
  bannedWords?: readonly string[];
}): ScreeningResult {
  const title = input.title.trim();
  const body = input.body.trim();
  const bannedWords = input.bannedWords ?? DEFAULT_BANNED_WORDS;

  if (title.length === 0 && body.length === 0) {
    return { verdict: 'blocked', rule: SCREENING_RULES.emptyContent, detail: '标题与正文都是空的。' };
  }

  const links = countExternalLinks(body);
  if (links > MAX_LINKS) {
    return {
      verdict: 'blocked',
      rule: SCREENING_RULES.excessiveLinks,
      detail: `正文里有 ${links} 个外部链接，超过 ${MAX_LINKS} 个的上限。`,
    };
  }

  const haystack = title + '\n' + body;
  const lowerHaystack = haystack.toLowerCase();
  for (const word of bannedWords) {
    const needle = word.trim().toLowerCase();
    if (needle.length === 0) continue;
    if (lowerHaystack.includes(needle)) {
      return {
        verdict: 'blocked',
        rule: SCREENING_RULES.bannedWord,
        // 不回显命中的词：否则等于告诉发帖人怎么绕过
        detail: '内容包含被禁止的关键词。',
      };
    }
  }

  // 标题全大写刷屏：只对纯英文标题有意义，中文没有大小写
  if (title.length >= ALL_CAPS_MIN && /^[A-Z0-9\s!?.,;:'"()\-]+$/.test(title)) {
    return {
      verdict: 'blocked',
      rule: SCREENING_RULES.allCapsTitle,
      detail: '标题全是英文大写字母，疑似刷屏。',
    };
  }

  // 连续重复字符刷屏
  const repeat = new RegExp('(.)\\1{' + MAX_REPEAT + ',}');
  if (repeat.test(body) || repeat.test(title)) {
    return {
      verdict: 'blocked',
      rule: SCREENING_RULES.repeatedChars,
      detail: `有连续超过 ${MAX_REPEAT} 个相同字符。`,
    };
  }

  return { verdict: 'passed', rule: '', detail: '' };
}
