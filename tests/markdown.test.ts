/**
 * Markdown 渲染与**净化**测试。
 *
 * 这是安全相关测试：去掉 rehype-sanitize，XSS 用例必须变红。
 */

import { describe, expect, it } from 'vitest';
import {
  renderMarkdownToSafeHtml,
  markdownToPlainText,
  extractMediaReferences,
} from '../src/server/platform/markdown';

describe('正常渲染', () => {
  it('标题、列表、强调、代码块正确渲染为 HTML', () => {
    const html = renderMarkdownToSafeHtml(
      ['## 用它做什么', '', '- 第一条', '- 第二条', '', '**加粗**与`行内代码`', '', '```ts', 'const a = 1;', '```'].join('\n'),
    );
    expect(html).toContain('<h2>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>第一条</li>');
    expect(html).toContain('<strong>加粗</strong>');
    expect(html).toContain('<code>');
  });

  it('GFM 表格与删除线可用', () => {
    const html = renderMarkdownToSafeHtml(['| 项 | 值 |', '| --- | --- |', '| a | 1 |', '', '~~删掉~~'].join('\n'));
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
    expect(html).toContain('<del>删掉</del>');
  });

  it('本站媒体地址的图片保留（这是正文插图的关键）', () => {
    const html = renderMarkdownToSafeHtml('![截图](/media/01920000-0000-7000-8000-0000000000aa/DISPLAY)');
    expect(html).toContain('<img');
    expect(html).toContain('src="/media/01920000-0000-7000-8000-0000000000aa/DISPLAY"');
  });

  it('空输入返回空串（不产出半个标签）', () => {
    expect(renderMarkdownToSafeHtml('')).toBe('');
    expect(renderMarkdownToSafeHtml(undefined as unknown as string)).toBe('');
  });
});

describe('净化：危险内容必须被清除', () => {
  it('内联 <script> 被清除', () => {
    const html = renderMarkdownToSafeHtml('正常文字\n\n<script>alert(1)</script>\n\n后面');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
    expect(html).toContain('正常文字');
  });

  it('事件属性（onerror / onclick）被清除', () => {
    const html = renderMarkdownToSafeHtml('<img src="/media/x/DISPLAY" onerror="alert(1)">\n\n<div onclick="evil()">点我</div>');
    expect(html.toLowerCase()).not.toContain('onerror');
    expect(html.toLowerCase()).not.toContain('onclick');
    expect(html).not.toContain('evil()');
  });

  it('javascript: 链接被清除', () => {
    const html = renderMarkdownToSafeHtml('[点我](javascript:alert(1))');
    expect(html.toLowerCase()).not.toContain('javascript:');
  });

  it('data: 协议的图片被清除（不允许内联任意数据）', () => {
    const html = renderMarkdownToSafeHtml('![x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)');
    expect(html.toLowerCase()).not.toContain('data:text/html');
  });

  it('iframe / style / form 等非正文标签被清除', () => {
    const html = renderMarkdownToSafeHtml(
      ['<iframe src="https://evil.example"></iframe>', '<style>body{display:none}</style>', '<form action="/x"><input name="a"></form>'].join('\n\n'),
    );
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('<form');
  });

  it('普通外链仍可用（净化不等于把功能全砍掉）', () => {
    const html = renderMarkdownToSafeHtml('[GitHub](https://github.com/example/repo)');
    expect(html).toContain('href="https://github.com/example/repo"');
  });
});

describe('纯文本提取（供搜索与摘要）', () => {
  it('去掉标记但保留可读内容', () => {
    const text = markdownToPlainText('## 标题\n\n**重点**内容，见 [链接](https://x.example)。\n\n- 列表项');
    expect(text).toContain('标题');
    expect(text).toContain('重点内容');
    expect(text).toContain('链接');
    expect(text).toContain('列表项');
    expect(text).not.toContain('##');
    expect(text).not.toContain('**');
    expect(text).not.toContain('https://');
  });

  it('不返回 HTML 标签', () => {
    const text = markdownToPlainText('<div>里面</div>');
    expect(text).not.toContain('<div>');
    expect(text).toContain('里面');
  });
});

describe('提取本站媒体引用（提交时核验用）', () => {
  it('提取出附件 ID 与变体，去重', () => {
    const refs = extractMediaReferences(
      '![a](/media/01920000-0000-7000-8000-0000000000aa/DISPLAY)\n\n![b](/media/01920000-0000-7000-8000-0000000000aa/DISPLAY)\n\n![c](/media/01920000-0000-7000-8000-0000000000bb/DISPLAY)',
    );
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.attachmentId)).toEqual([
      '01920000-0000-7000-8000-0000000000aa',
      '01920000-0000-7000-8000-0000000000bb',
    ]);
  });

  it('外部图片链接不会被当成附件', () => {
    const refs = extractMediaReferences('![x](https://evil.example/track.png)');
    expect(refs).toHaveLength(0);
  });
});
