$ErrorActionPreference = 'Stop'
$f = 'src\app\plugins\page.tsx'
$text = Get-Content -LiteralPath $f -Raw -Encoding UTF8

$pairs = @(
  @('import { UNCLASSIFIED_TAG } from ''@/server/modules/catalog/service'';',
    'import { UNCATEGORIZED_CATEGORY } from ''@/server/modules/catalog/service'';'),
  @('{tags.length > 0 ? (', '{categories.length > 0 ? ('),
  @('<Link href={listHref(conditions, { tag: undefined })} className={conditions.tag ? '''' : ''active''}>',
    '<Link href={listHref(conditions, { cat: undefined })} className={conditions.cat ? '''' : ''active''}>'),
  @('{tags.map((t) => (', '{categories.map((c) => ('),
  @('                  key={t.tag}
                  href={listHref(conditions, { tag: t.tag })}
                  className={conditions.tag === t.tag ? ''active'' : ''''}
                  title={t.tag === UNCLASSIFIED_TAG ? ''没有命中任何分类的插件'' : `原始 topic：${t.tag}`}',
    '                  key={c.slug}
                  href={listHref(conditions, { cat: c.slug })}
                  className={conditions.cat === c.slug ? ''active'' : ''''}
                  title={c.slug === UNCATEGORIZED_CATEGORY ? ''没有命中任何分类的插件（去后台补映射）'' : `覆盖 ${c.repositoryCount} 个仓库 / ${c.pluginCount} 个插件`}'),
  @('                  <span className="truncate">{t.tag === UNCLASSIFIED_TAG ? ''未分类'' : t.tag}</span>
                  <span className="count">{t.pluginCount}</span>',
    '                  <span className="truncate">{c.label}</span>
                  {/* 计数口径：不同仓库数（monorepo 不会把一个分类放大 11 倍） */}
                  <span className="count">{c.repositoryCount}</span>'),
  @('{conditions.tag ? <input type="hidden" name="tag" value={conditions.tag} /> : null}',
    '{conditions.cat ? <input type="hidden" name="cat" value={conditions.cat} /> : null}
              {conditions.tag ? <input type="hidden" name="tag" value={conditions.tag} /> : null}')
)
foreach ($p in $pairs) {
  if (-not $text.Contains($p[0])) { throw ('锚点没找到：' + $p[0].Substring(0, [Math]::Min(60, $p[0].Length))) }
  $text = $text.Replace($p[0], $p[1])
}
Set-Content -LiteralPath $f -Value $text -NoNewline -Encoding UTF8
'  plugins 页侧栏已切到分类'
