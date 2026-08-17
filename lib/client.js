/**
 * dsh-plugin-catalog browser half — 设置 → 插件目录.
 *
 * Renders the installed profile bundles as a grouped, searchable catalog:
 *  - auto-grouped by source (DSH 官方核心 / UI 全家桶 / 社区扩展 / OMDSH 生态 /
 *    GitHub 安装 / 本地自装 / 其他), collapsible groups
 *  - per-plugin note editor (备注), persisted host-side via PUT
 *    /plugin-catalog/api/notes (shared across devices)
 *  - free-text search over name + description
 *
 * Data: GET /plugin-catalog/api/list returns { entries, notes }.
 * Rendering follows the dsh-plugin-guard settings-section pattern:
 * `slots.inject('settings.section', ...)` + React.createElement.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-catalog',
  factory: (require) => {
    const React = require('react')
    const { useEffect, useState, useMemo, useCallback } = React

    const KIND_ORDER = ['DSH 官方核心', 'UI 全家桶', '社区扩展', 'OMDSH 生态', 'GitHub 安装', '本地自装', '其他']

    const CSS = `
.pc-wrap{display:flex;flex-direction:column;gap:12px;max-width:860px}
.pc-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pc-search{flex:1;min-width:160px;height:32px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:13px;outline:none}
.pc-search:focus{border-color:var(--dsw-alias-state-business-primary)}
.pc-count{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:32px}
.pc-group{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.pc-groupHead{display:flex;align-items:center;gap:8px;width:100%;cursor:pointer;background:none;border:none;padding:10px 14px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);text-align:left}
.pc-groupHead:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pc-chevron{transition:transform .15s;color:var(--dsw-alias-label-tertiary);font-size:11px}
.pc-chevronOpen{transform:rotate(90deg)}
.pc-groupCount{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400}
.pc-row{display:flex;flex-direction:column;gap:6px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.pc-rowTop{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.pc-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);font-family:ui-monospace,monospace}
.pc-ver{color:var(--dsw-alias-label-tertiary);font-size:11px}
.pc-badge{border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;white-space:nowrap}
.pc-badgeLocal{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.pc-badgeGithub{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}
.pc-badgeCore{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary)}
.pc-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;word-break:break-all}
.pc-noteRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pc-noteInput{flex:1;min-width:140px;height:28px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);border-radius:6px;padding:0 8px;font-size:12px;outline:none}
.pc-noteInput:focus{border-color:var(--dsw-alias-state-business-primary)}
.pc-noteSaved{color:var(--dsw-alias-state-success-primary, #2fb344);font-size:11px}
.pc-btn{height:28px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;padding:0 10px}
.pc-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pc-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;padding:16px;text-align:center}
.pc-loading{color:var(--dsw-alias-label-tertiary);font-size:13px;padding:16px}
.pc-source{color:var(--dsw-alias-label-caption);font-size:11px;word-break:break-all}
`

    function installStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="dsh-plugin-catalog/styles"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-catalog'
      tag.dataset.pluginCss = 'dsh-plugin-catalog/styles'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function shortSource(source) {
      if (!source) return ''
      if (source.startsWith('link:')) return '本地'
      if (source.startsWith('github:')) return source.slice('github:'.length).split('#')[0]
      return source
    }

    function PluginCatalogSection() {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [query, setQuery] = useState('')
      const [open, setOpen] = useState(() => {
        const o = {}
        KIND_ORDER.forEach((k) => { o[k] = true })
        return o
      })
      const [drafts, setDrafts] = useState({})
      const [saving, setSaving] = useState('')
      const [saved, setSaved] = useState('')

      const load = useCallback(async () => {
        try {
          const res = await fetch('/plugin-catalog/api/list', { credentials: 'include' })
          const j = await res.json()
          if (!j.ok) throw new Error(j.error || '加载失败')
          setData(j)
          setError('')
        } catch (err) {
          setError('插件目录加载失败：' + String(err.message || err))
        }
      }, [])

      useEffect(() => { load() }, [load])

      const saveNote = useCallback(async (pkg) => {
        const note = (drafts[pkg] || '').trim()
        setSaving(pkg)
        setSaved('')
        try {
          const res = await fetch('/plugin-catalog/api/notes', {
            method: 'PUT',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pkg, note }),
          })
          const j = await res.json()
          if (!j.ok) throw new Error(j.error || '保存失败')
          setData((d) => d ? { ...d, notes: { ...d.notes, [pkg]: { note } } } : d)
          setSaved(pkg)
        } catch (err) {
          setError('备注保存失败：' + String(err.message || err))
        } finally {
          setSaving('')
        }
      }, [drafts])

      const groups = useMemo(() => {
        if (!data) return []
        const q = query.trim().toLowerCase()
        const filtered = data.entries.filter((e) => {
          if (!q) return true
          return (e.name || '').toLowerCase().includes(q) ||
            (e.description || '').toLowerCase().includes(q)
        })
        const map = new Map()
        for (const e of filtered) {
          const kind = e.kind || '其他'
          if (!map.has(kind)) map.set(kind, [])
          map.get(kind).push(e)
        }
        const order = [...KIND_ORDER.filter((k) => map.has(k)), ...[...map.keys()].filter((k) => !KIND_ORDER.includes(k))]
        return order.map((k) => ({ kind: k, items: map.get(k).sort((a, b) => a.name.localeCompare(b.name)) }))
      }, [data, query])

      if (error && !data) {
        return React.createElement('div', { className: 'pc-wrap' },
          React.createElement('div', { className: 'pc-error pc-empty' }, error),
          React.createElement('button', { className: 'pc-btn', onClick: load }, '重试'))
      }

      return React.createElement('div', { className: 'pc-wrap' },
        React.createElement('div', { className: 'pc-toolbar' },
          React.createElement('input', {
            className: 'pc-search', placeholder: '搜索插件名 / 描述…',
            value: query, onChange: (e) => setQuery(e.target.value),
          }),
          React.createElement('span', { className: 'pc-count' },
            data ? data.entries.length + ' 个已装插件' : '…'),
          React.createElement('button', { className: 'pc-btn', onClick: load }, '刷新'),
        ),
        error ? React.createElement('div', { className: 'pc-empty' }, error) : null,
        !data ? React.createElement('div', { className: 'pc-loading' }, '加载中…') :
          groups.length === 0 ? React.createElement('div', { className: 'pc-empty' }, '没有匹配的插件') :
          groups.map((g) =>
            React.createElement('div', { key: g.kind, className: 'pc-group' },
              React.createElement('button', {
                className: 'pc-groupHead',
                onClick: () => setOpen((o) => ({ ...o, [g.kind]: !o[g.kind] })),
              },
                React.createElement('span', { className: 'pc-chevron' + (open[g.kind] ? ' pc-chevronOpen' : '') }, '▶'),
                React.createElement('span', null, g.kind),
                React.createElement('span', { className: 'pc-groupCount' }, g.items.length + ' 个'),
              ),
              open[g.kind] === false ? null :
                g.items.map((e) => {
                  const note = (data.notes && data.notes[e.name] && data.notes[e.name].note) || ''
                  const draft = drafts[e.name] !== undefined ? drafts[e.name] : note
                  const badgeCls = e.kind === '本地自装' ? 'pc-badge pc-badgeLocal'
                    : e.kind === 'GitHub 安装' ? 'pc-badge pc-badgeGithub'
                    : e.kind === 'DSH 官方核心' ? 'pc-badge pc-badgeCore' : 'pc-badge pc-badgeCore'
                  return React.createElement('div', { key: e.name, className: 'pc-row' },
                    React.createElement('div', { className: 'pc-rowTop' },
                      React.createElement('span', { className: 'pc-name' }, e.name),
                      e.version ? React.createElement('span', { className: 'pc-ver' }, 'v' + e.version) : null,
                      React.createElement('span', { className: badgeCls }, e.kind),
                    ),
                    e.description ? React.createElement('div', { className: 'pc-desc' }, e.description) : null,
                    React.createElement('div', { className: 'pc-source' }, '来源: ' + shortSource(e.source)),
                    React.createElement('div', { className: 'pc-noteRow' },
                      React.createElement('input', {
                        className: 'pc-noteInput',
                        placeholder: '备注：这个插件是干嘛的…',
                        value: draft,
                        onChange: (ev) => setDrafts((d) => ({ ...d, [e.name]: ev.target.value })),
                        onKeyDown: (ev) => { if (ev.key === 'Enter') saveNote(e.name) },
                      }),
                      React.createElement('button', {
                        className: 'pc-btn',
                        disabled: saving === e.name,
                        onClick: () => saveNote(e.name),
                      }, saving === e.name ? '保存中…' : '保存'),
                      saved === e.name ? React.createElement('span', { className: 'pc-noteSaved' }, '✓') : null,
                    ),
                  )
                }),
            ),
          ),
      )
    }

    function apply(ctx) {
      const slots = ctx.slots
      ctx.effect(installStyles)
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'plugin-catalog', order: 60, label: '插件目录' },
        PluginCatalogSection,
      ))
    }

    return { apply, inject: ['slots'] }
  },
})