# dsh-plugin-catalog

> A plugin catalog for the DeepSeek Harness web GUI: 设置 → **插件目录**. Every installed profile bundle is listed, **auto-grouped by source** (DSH core / UI suite / community / OMDSH / GitHub / local), **searchable** by name or description, with a **per-plugin note editor** persisted host-side (shared across devices).
>
> DSH Web GUI 插件目录：设置 → **插件目录**。已装插件**自动分类**、**搜索**、**逐插件备注**（host 端持久化，跨设备共享）。

---

## English

### Features

- **Auto-grouped catalog**: DSH 官方核心 / UI 全家桶 / 社区扩展 / OMDSH 生态 / GitHub 安装 / 本地自装 / 其他 — collapsible groups, sorted by name
- **Per-plugin info**: package name, version, group badge, description (falls back to the dsh main package for built-in bundles), source (local / GitHub / built-in)
- **Search**: realtime filter over name + description
- **Notes (annotations)**: one note per plugin, saved host-side to `$DSH_HOME/plugin-catalog/notes.json` — same notes on your phone and desktop
- **Refresh**: reloads the list at any time

### How it works

- **Host half** (`lib/index.js`): two read-only-ish HTTP APIs
  - `GET /plugin-catalog/api/list` — reads the profile `package.json` (bundles + dependencies) and each package's metadata, returns `{ entries, notes }`
  - `GET/PUT /plugin-catalog/api/notes` — note read/write (the only write: your notes file under `$DSH_HOME/plugin-catalog/`, never touches node_modules)
- **Browser half** (`lib/client.js`): a Settings section "插件目录" registered via `slots.inject('settings.section')` (same pattern as dsh-plugin-guard's backup manager), rendered with React.createElement

### Install

```bash
dsh plugin --profile web add github:fengs2021/dsh-plugin-catalog
systemctl restart dsh-web   # or hot-mount via dev tools (no restart)
```

Then open **设置 → 插件目录** (Settings → Plugin Catalog).

### Notes

- Safe by design: the host half only reads package.json metadata and writes one JSON file under `$DSH_HOME/plugin-catalog/` — it never writes into `node_modules` or any dsh-managed path
- Categories are auto-derived from the dependency spec (`link:` / `github:` / built-in / scope prefix)

## 中文

### 功能

- **自动分类**：已装插件按来源自动分 7 组（DSH 官方核心 / UI 全家桶 / 社区扩展 / OMDSH 生态 / GitHub 安装 / 本地自装 / 其他），分组可折叠、组内按名称排序
- **每插件信息**：包名、版本、分类徽标、描述（内置包自动回退读 dsh 主包）、来源（本地/GitHub/内置）
- **搜索**：按插件名或描述关键字实时过滤
- **备注**：每插件一个备注输入框，存到 `$DSH_HOME/plugin-catalog/notes.json`——手机/电脑跨设备共享
- **刷新**：随时重新加载列表

### 实现

- host（`lib/index.js`）：
  - `GET /plugin-catalog/api/list`：读 profile `package.json`（bundles + dependencies）与各包元数据，返回 `{ entries, notes }`
  - `GET/PUT /plugin-catalog/api/notes`：备注读写（唯一的写操作 = 你的备注文件，绝不碰 node_modules）
- client（`lib/client.js`）：设置页 section「插件目录」（`slots.inject('settings.section')` 模式，同 dsh-plugin-guard 备份管理），React.createElement 渲染

### 安装

```bash
dsh plugin --profile web add github:fengs2021/dsh-plugin-catalog
systemctl restart dsh-web   # 或 dev 工具热装配（免重启）
```

然后打开 设置 → 插件目录。

### 说明

- 安全设计：host 半只读 package.json 元数据 + 写一个 `$DSH_HOME/plugin-catalog/` 下的 JSON 文件——绝不写入 node_modules 或任何 dsh 管理路径
- 分类自动派生：按依赖 spec（`link:` / `github:` / 内置 / scope 前缀）

## License

MIT