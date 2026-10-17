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
    // 文章目录锚点：`id` 由下面 plugins 里的 headingIds **服务端生成**（不是作者写的），
    // 因为 remark-rehype 默认丢弃原始 HTML，作者无法自己塞属性进来；这里放行只是为了
    // 让生成出来的 id 能活过净化，从而让目录链接可用（无 JS 也能跳到小节）。
    h1: ['id'],
    h2: ['id'],
    h3: ['id'],
    h4: ['id'],
    h5: ['id'],
    h6: ['id'],
  },
  protocols: {
    ...defaultSchema.protocols,
    // 显式只允许安全协议：**没有 javascript:**、没有 data:
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https'],
  },
  /**
   * 关掉 id 的 `user-content-` 前缀。
   *
   * 这个前缀是 rehype-sanitize 防 DOM clobbering 的默认保护（防止作者塞一个 id 去覆盖
   * `document.xxx`）。本站的正文 id **只有一个来源**：上面 pluginHeadingIds 生成的 `h-1`、
   * `h-2`…，而 remark-rehype 默认丢弃原始 HTML，作者**无法**自己写属性进来（有测试钉住）。
   * 因此这里关掉前缀不会削弱保护，换来的是目录锚点短且可读（`#h-3` 而不是 `#user-content-h-3`）。
   * 若将来放行任何**作者可控**的 id/name，必须把这条改回去。
   */
  clobberPrefix: '',
};

/** 文章大纲的一条（供页面渲染"目录"）。 */
export interface ArticleOutlineEntry {
  id: string;
  level: number;
  text: string;
}

/** hast 节点的最小形状（只用到这几个字段）。 */
interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** 把标题节点的文字抽出来（供目录显示；不含任何标签）。 */
function headingText(node: HastNode): string {
  let out = typeof node.value === 'string' ? node.value : '';
  if (Array.isArray(node.children)) out += node.children.map(headingText).join('');
  return out;
}

/**
 * 给标题加锚点 id，并顺手收集文章大纲。
 *
 * 为什么在**净化之前**跑：这样生成出来的 id 会经过白名单校验（schema 里给 h1—h6 放行了 `id`），
 * 而不是"先净化再加属性"绕过校验。
 * 为什么 id 用序号（`h-1`、`h-2`…）而不是标题文字：中文标题做 slug 既难看又不稳定
 * （改一个标点就会让已分享的锚点失效）；序号稳定且天然唯一。
 */
function pluginHeadingIds() {
  return (tree: HastNode, file: { data: Record<string, unknown> }) => {
    const outline: ArticleOutlineEntry[] = [];
    let seq = 0;

    const walk = (node: HastNode) => {
      if (!Array.isArray(node.children)) return;
      for (const child of node.children) {
        if (child.tagName && HEADING_TAGS.has(child.tagName)) {
          seq += 1;
          const id = `h-${seq}`;
          child.properties = { ...(child.properties ?? {}), id };
          const text = headingText(child).trim();
          if (text !== '') {
            outline.push({ id, level: Number(child.tagName.slice(1)), text });
          }
        }
        walk(child);
      }
    };
    walk(tree);

    file.data.outline = outline;
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(pluginHeadingIds)
  .use(rehypeSanitize, schema)
  .use(rehypeStringify);

/**
 * 渲染 Markdown 为**已净化**的 HTML，并同时给出文章大纲（标题 + 锚点 id）。
 *
 * 目录用的 id 是服务端生成的，所以目录链接在**没有 JS** 的情况下也能用。
 */
export function renderArticleMarkdown(markdown: string): { html: string; outline: ArticleOutlineEntry[] } {
  if (typeof markdown !== 'string' || markdown.length === 0) return { html: '', outline: [] };
  const file = processor.processSync(markdown);
  const outline = (file.data as { outline?: ArticleOutlineEntry[] }).outline ?? [];
  return { html: String(file), outline };
}

/** 渲染 Markdown 为**已净化**的 HTML 字符串。 */
export function renderMarkdownToSafeHtml(markdown: string): string {
  return renderArticleMarkdown(markdown).html;
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
