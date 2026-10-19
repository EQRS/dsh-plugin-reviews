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
        <h2 style={{ fontSize: 16, marginTop: 0 }}>五、提交前自查</h2>
        <ul style={{ ...V, marginTop: 4, paddingLeft: 20, listStyle: 'none' }}>
          <li>☐ 判定是五状态之一，且与正文结论一致</li>
          <li>☐ 有结论的判定，附了至少 1 条可点开的证据链接</li>
          <li>☐ 写清了被测版本、DSH 版本与环境</li>
          <li>☐ 没写总分、星级、全能排名</li>
          <li>☐ 没测的部分写了「未测」</li>
        </ul>
      </div>

      <div className="panel">
        <h2 style={{ fontSize: 16, marginTop: 0 }}>六、规范原文（dsh-bench）</h2>
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
