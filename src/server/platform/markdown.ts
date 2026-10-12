/**
 * Markdown 安全渲染（架构第 25 节）。
 *
 * 统一管线：remark-parse → remark-gfm → remark-rehype → **rehype-sanitize** → rehype-stringify
 *
 * 铁律：
 *  1. **必须经过 sanitize**：正文是用户输入，绝不允许脚本、事件属性或 javascript: 链接进入 HTML；
 *  2. 只允许本站固定媒体地址 `/media/...` 与安全外链；
 *  3. 渲染结果不执行 MDX；原始 Markdown 始终是权威内容（HTML 只是可重建的展示结果）；
 *  4. 纯文本提取用于搜索/摘要，不与展示 HTML 混用。
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';

/**
 * 白名单 schema：以 hast 默认 schema 为基线，只放开正文真正需要的东西。
 * 默认 schema 已经禁止 script/style/事件属性，这里显式收紧链接协议并放开图片尺寸属性。
 */
const schema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    // 允许 GFM 的表格/删除线（remark-gfm 会产出这些标签）
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'del', 'input',
  ],
  attributes: {
    ...defaultSchema.attributes,
    img: [
      ...((defaultSchema.attributes?.img as string[]) ?? []),
      'src', 'alt', 'title', 'width', 'height', 'loading',
    ],
    a: [
      ...((defaultSchema.attributes?.a as string[]) ?? []),
      'href', 'title', 'target', 'rel',
    ],
    // GFM 任务列表的复选框
    input: ['type', 'checked', 'disabled'],
    code: [...((defaultSchema.attributes?.code as string[]) ?? []), 'className'],
    span: [...((defaultSchema.attributes?.span as string[]) ?? []), 'className'],
  },
  protocols: {
    ...defaultSchema.protocols,
    // 显式只允许安全协议：**没有 javascript:**、没有 data:
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https'],
  },
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize, schema)
  .use(rehypeStringify);

/** 渲染 Markdown 为**已净化**的 HTML 字符串。 */
export function renderMarkdownToSafeHtml(markdown: string): string {
  if (typeof markdown !== 'string' || markdown.length === 0) return '';
  const file = processor.processSync(markdown);
  return String(file);
}

/**
 * 提取用于搜索/摘要的纯文本。
 *
 * 不返回 HTML，也不保留标记；代码块保留内容（便于搜索代码片段）。
 */
export function markdownToPlainText(markdown: string): string {
  if (typeof markdown !== 'string' || markdown.length === 0) return '';
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, ''))
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 从 Markdown 中提取本站媒体引用（`/media/{附件ID}/{变体}`）。
 * 提交时用它核验：正文引用的图片必须是**本人有权使用的 ready 文件**。
 */
export function extractMediaReferences(markdown: string): { attachmentId: string; variantKey: string }[] {
  if (typeof markdown !== 'string' || markdown.length === 0) return [];
  const out: { attachmentId: string; variantKey: string }[] = [];
  const seen = new Set<string>();
  const re = /\/media\/([0-9a-f-]{36})\/([A-Za-z]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const key = `${m[1]}/${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ attachmentId: m[1] as string, variantKey: m[2] as string });
  }
  return out;
}
