import Link from 'next/link';
import type { Metadata } from 'next';
import { BackLink } from '@/components/back-link';

/**
 * 测评规范页（给上传测评的人看的规则）。
 *
 * 内容对齐 dsh-bench（FuRongJun-1999/dsh-bench）的工程协议手册 v1.1 与本站
 * `packages/common/verdict` 的硬约束：
 *   - 五状态判定；有结论的判定必须带可复核证据链；
 *   - 不给总分、不用星级；能力／花费／安全分开说；
 *   - 装不上就写装不上；未测就写「未测」；效果只管 90 天。
 *
 * 页面是纯静态（无登录、无数据库），任何访客都能读——上传前先把规则看明白。
 */
export const metadata: Metadata = {
  title: '测评规范 · DSH 插件评测',
  description: '上传测评前先看：五状态判定、证据链要求、三档位与硬约束（对齐 dsh-bench 测评规范）。',
};

const V = { fontSize: 13, lineHeight: 1.7 } as const;
const cell = { padding: '8px 10px', borderBottom: '1px solid var(--line, #e3e7dd)', verticalAlign: 'top' } as const;

/** 用词规范（docs/用词规范.md）里最常用的两张替换表，页面内做成紧凑两栏。 */
const WORD_REPLACEMENTS: [string, string][] = [
  ['范式', '做法'],
  ['契约', '要求'],
  ['闸门 / 门槛', '限制'],
  ['证据链', '能点开的记录'],
  ['配对对照', '一组装、一组不装，做同样的事'],
  ['统计判定', '按次数比'],
  ['渐进披露', '先给一点，再给更多'],
  ['鉴权', '身份检查'],
  ['闭环', '写完能读回'],
  ['飞轮', '反复积累'],
  ['口径 / 档位', '标准、等级'],
  ['落盘', '存到本地'],
  ['开箱', '装完就能用'],
  ['生态', '插件圈'],
  ['元认知', '自我检查'],
  ['归因', '找原因'],
  ['维度', '方面'],
  ['召回', '找回来'],
  ['注入', '塞进对话'],
  ['上下文', '对话内容'],
];

const EN_REPLACEMENTS: [string, string][] = [
  ['Node', '运行环境'],
  ['npm', '安装工具'],
  ['API', '网页接口'],
  ['HTTP', '网页请求'],
  ['SQLite', '本地数据库'],
  ['MIT / BSD / Apache', '开源许可'],
  ['beta / rc', '测试版'],
  ['issue', '问题'],
  ['tag / commit / release', '版本标记、提交记录、发布页'],
  ['profile', '配置'],
  ['demo', '演示'],
  ['star', '星'],
];

const BANNED_WORDS: { label: string; words: string[] }[] = [
  { label: '程度', words: ['非常', '十分', '极其', '特别', '相当', '比较', '挺', '蛮', '太', '很', '更', '尤其', '格外'] },
  { label: '肯定强调', words: ['真的', '确实', '实在', '的确', '明明'] },
  { label: '夸张', words: ['大幅', '显著', '明显', '彻底', '完全', '全部', '所有', '几乎', '基本上'] },
  { label: '语气', words: ['其实', '竟然', '居然', '简直', '反倒', '反而'] },
  { label: '推测', words: ['大概', '可能', '也许', '似乎', '好像', '恐怕'] },
  { label: '方式', words: ['好好地', '牢牢', '狠狠地', '慢慢地', '快速地', '仔细地', '认真地'] },
];

const WORDING_EXAMPLES: [string, string][] = [
  ['它是唯一有公开标准测评判定的', '十个插件里，只有它有一份公开报告，报告写的是「有用」'],
  ['不装的那一组连工具都不存在', '不装的那一组，写的时候报「找不到工具」'],
  ['有 27 个依赖，是最重的', '装它要顺带装 27 个东西'],
  ['引擎区间是硬闸门', '你的 DSH 版本不在它写的范围里，它就装不上'],
  ['主动注入等于吃对话内容', '它每次都把记忆塞进对话，占地方'],
];

const WORDING_CHECKS = [
  '通读一遍，有没有一个初中生看不懂的词',
  '搜一遍英文字母，除例外五项外还有没有',
  '搜禁用词，命中即改',
  '每句是不是只说了一件事',
  '跑一遍检查脚本，error 清零',
];

export default function SpecPage() {
  return (
    <div>
      <BackLink href="/">返回首页</BackLink>
      <h1 style={{ fontSize: 26, marginBottom: 6 }}>测评规范</h1>
      <p className="muted" style={{ marginTop: 0, ...V }}>
        写在一篇测评前面：<strong>一篇测评只给一个判定（五状态之一）；不给总分、不用星级；有结论的判定必须带可复核的证据链。</strong>
        本页是 dsh-bench 测评规范的站内摘要，规则原文见页尾链接。
      </p>

      <div className="panel">
        <h2 style={{ fontSize: 16, marginTop: 0 }}>一、五状态怎么判</h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', ...V }}>
            <thead>
              <tr style={{ textAlign: 'left' }}>
                <th style={{ ...cell, width: 120 }}>判定</th>
                <th style={cell}>什么意思</th>
                <th style={{ ...cell, width: 110 }}>证据</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={cell}><strong>真有用</strong></td>
                <td style={cell}>这次实测里，插件比「不装它」确实多干成了活（有配对读数，不是感觉）。</td>
                <td style={cell}>≥1 条可复核链接</td>
              </tr>
              <tr>
                <td style={cell}><strong>帮倒忙</strong></td>
                <td style={cell}>装它反而更差（同样的活失败更多／更慢／更贵），且方向明确。</td>
                <td style={cell}>≥1 条</td>
              </tr>
              <tr>
                <td style={cell}><strong>没啥差别</strong></td>
                <td style={cell}>这次范围内看不出差别。<strong>「没啥差别」不是绝对一样。</strong></td>
                <td style={cell}>≥1 条</td>
              </tr>
              <tr>
                <td style={cell}><strong>还说不准</strong></td>
                <td style={cell}>数据不够、精度不够、跨阈值——照实说不知道。</td>
                <td style={cell}>可以没有</td>
              </tr>
              <tr>
                <td style={cell}><strong>没法测</strong></td>
                <td style={cell}>装不上／环境不支持／任务不适用——<strong>分别写原因</strong>。</td>
                <td style={cell}>可以没有</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2 style={{ fontSize: 16, marginTop: 0 }}>二、证据链怎么写</h2>
        <ul style={{ ...V, marginTop: 4, paddingLeft: 20 }}>
          <li>每行一条：<code>链接</code> 或 <code>链接 | 备注</code>，一篇最多 10 条。</li>
          <li>链接必须能点开（http/https），能复现、能复核：配对 A/B 读数、门禁输出、复现步骤、日志。</li>
          <li>不接受感受、裸域名、空串；「真有用／帮倒忙／没啥差别」至少 1 条，「还说不准／没法测」可以没有。</li>
        </ul>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          例：<code>https://github.com/.../compare/a...b | 配对 A/B 前后各 5 次读数</code>
        </p>
      </div>

      <div className="panel">
        <h2 style={{ fontSize: 16, marginTop: 0 }}>三、档位决定能说什么</h2>
        <ul style={{ ...V, marginTop: 4, paddingLeft: 20 }}>
          <li><strong>体验快测</strong>：装一遍、用一遍，只记「查到什么、结果怎样」；不出五状态、不进能力榜；禁用「通过／合格」这类词。</li>
          <li><strong>标准测评</strong>：配对对照 + 统计判定，才能出五状态。本站线上提交按这个口径收：五状态 + 证据链。</li>
          <li><strong>深度审计</strong>：标准测评 + 安全六威胁全项；未测就写「未测」。</li>
        </ul>
      </div>

      <div className="panel">
        <h2 style={{ fontSize: 16, marginTop: 0 }}>四、三条硬规矩</h2>
        <ol style={{ ...V, marginTop: 4, paddingLeft: 20 }}>
          <li><strong>不给总分、不用星级</strong>：能力／花费／安全分开说，不合成一个数，不搞全能总榜。</li>
          <li><strong>装不上就写装不上</strong>：能力「没法测」+ 安装环节「失败」分开记，不编分数凑数。</li>
          <li><strong>未测就写「未测」，不留空</strong>；效果只管 90 天，到期自动退出推荐（改日期不算续期）。</li>
        </ol>
      </div>

      <div className="panel">
        <h2 style={{ fontSize: 16, marginTop: 0 }}>五、用词规范</h2>
        <p className="muted" style={{ marginTop: 0, ...V }}>
          站内测评正文、插件简介、结论速览、表格、评论回复、给作者的反馈都照此写；代码、命令输出、录屏里用户的原话、内部工作笔记不适用。
        </p>

        <ol className="wording-rules">
          <li>
            <strong>用初中词汇</strong>
            <span>换掉一个词，意思不变，就换</span>
          </li>
          <li>
            <strong>一句说一件事</strong>
            <span>超过 30 字就拆开</span>
          </li>
          <li>
            <strong>不用英文</strong>
            <span>除插件名、版本号、命令与路径、DSH / DeepSeek、网址</span>
          </li>
          <li>
            <strong>不用专有词</strong>
            <span>见下面的替换表</span>
          </li>
          <li>
            <strong>不堆修饰词</strong>
            <span>程度、肯定、夸张、语气、推测、方式</span>
          </li>
        </ol>

        <div className="wording-cols">
          <div>
            <p className="side-title" style={{ marginTop: 0 }}>
              专有词 → 换成
            </p>
            <table className="wording-table">
              <tbody>
                {WORD_REPLACEMENTS.map(([from, to]) => (
                  <tr key={from}>
                    <td>
                      <code>{from}</code>
                    </td>
                    <td>{to}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <p className="side-title" style={{ marginTop: 0 }}>
              英文 → 换成
            </p>
            <table className="wording-table">
              <tbody>
                {EN_REPLACEMENTS.map(([from, to]) => (
                  <tr key={from}>
                    <td>
                      <code>{from}</code>
                    </td>
                    <td>{to}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              可以用：插件名、版本号、命令与路径、DSH / DeepSeek、网址。
            </p>
          </div>
        </div>

        <p className="side-title" style={{ marginTop: 18 }}>
          禁用的修饰词
        </p>
        <div className="wording-banned">
          {BANNED_WORDS.map((group) => (
            <p key={group.label}>
              <strong>{group.label}</strong>
              {group.words.map((w) => (
                <code key={w}>{w}</code>
              ))}
            </p>
          ))}
        </div>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          例外：<strong>「最」</strong>在客观比较里可以用（星最多、版本最高），在评价里不能用（最好用、最强）。
        </p>

        <details className="wording-more">
          <summary>正反例、发布前自查与检查脚本</summary>
          <table className="wording-table">
            <thead>
              <tr>
                <th style={{ ...cell, width: '45%' }}>反面</th>
                <th style={cell}>正面</th>
              </tr>
            </thead>
            <tbody>
              {WORDING_EXAMPLES.map(([bad, good]) => (
                <tr key={bad}>
                  <td style={cell}>{bad}</td>
                  <td style={cell}>{good}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul style={{ ...V, margin: 0, paddingLeft: 20, listStyle: 'none' }}>
            {WORDING_CHECKS.map((item) => (
              <li key={item}>☐ {item}</li>
            ))}
          </ul>
          <pre className="wording-code">
            <code>{`npm run check:wording
node scripts/check-wording.mjs assessment/2026-10.md
node scripts/check-wording.mjs --strict docs/x.md`}</code>
          </pre>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            只对「对外文字」生效，不扫技术文档；接口清单、部署说明里的 API、HTTP 是准确说法，不该改。
          </p>
        </details>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          本页是摘要，完整版见仓库 <code>docs/用词规范.md</code>。
        </p>
      </div>

      <div className="panel">
        <h2 style={{ fontSize: 16, marginTop: 0 }}>六、提交前自查</h2>
        <ul style={{ ...V, marginTop: 4, paddingLeft: 20, listStyle: 'none' }}>
          <li>☐ 判定是五状态之一，且与正文结论一致</li>
          <li>☐ 有结论的判定，附了至少 1 条可点开的证据链接</li>
          <li>☐ 写清了被测版本、DSH 版本与环境</li>
          <li>☐ 没写总分、星级、全能排名</li>
          <li>☐ 没测的部分写了「未测」</li>
        </ul>
      </div>

      <div className="panel">
        <h2 style={{ fontSize: 16, marginTop: 0 }}>七、规范原文（dsh-bench）</h2>
        <ul style={{ ...V, marginTop: 4, paddingLeft: 20 }}>
          <li><a href="https://github.com/FuRongJun-1999/dsh-bench/blob/main/docs/spec/%E5%B7%A5%E7%A8%8B%E5%8D%8F%E8%AE%AE%E6%89%8B%E5%86%8C-v1.1.md" target="_blank" rel="noreferrer">工程协议手册 v1.1（判定算法、证据与治理）</a></li>
          <li><a href="https://github.com/FuRongJun-1999/dsh-bench/blob/main/docs/spec/%E6%8F%92%E4%BB%B6%E6%B5%8B%E8%AF%84%E7%AB%99-%E6%96%B9%E6%A1%88v3.0-%E5%AE%8C%E6%95%B4%E4%BF%AE%E8%AE%A2%E7%89%88.md" target="_blank" rel="noreferrer">插件测评站方案 v3.0（完整修订版）</a></li>
          <li><a href="https://github.com/FuRongJun-1999/dsh-bench/blob/main/docs/spec/%E7%AB%AF%E5%88%B0%E7%AB%AF%E9%AA%8C%E8%AF%81%E8%AE%A1%E5%88%92-v0.md" target="_blank" rel="noreferrer">端到端验证计划 v0（§7 判定算法边界回归表）</a></li>
        </ul>
      </div>

      <p className="muted" style={{ fontSize: 12 }}>
        想直接开始写？去 <Link href="/reviews">评测列表</Link> 或 <Link href="/me">我的评测</Link> 里发起一篇；提交前回本页对一遍自查清单。
      </p>
    </div>
  );
}
