/**
 * dsh-plugin-catalog host half.
 *
 * HTTP API for the 插件目录 settings section:
 *   GET /plugin-catalog/api/list   → installed profile bundles, grouped metadata
 *                                    (name, version, description, source, kind)
 *   GET /plugin-catalog/api/notes  → { "<pkg>": { note, category } }
 *   PUT /plugin-catalog/api/notes  → upsert one entry (body: { pkg, note?, category? })
 *
 * Data source: $DSH_HOME/profiles/web/package.json (dependencies + bundles),
 * each package's node_modules/.../package.json for version/description, and
 * the dependency spec (link:/github:) for source classification. Notes are
 * persisted at $DSH_HOME/plugin-catalog/notes.json (host-side, shared across
 * devices). No dsh sources are touched.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const name = "plugin-catalog";

const inject = ["webServer"];

/** Group label for one plugin entry. */
function classify(pkg, spec) {
  if (pkg.startsWith("@deepseek-ai/")) return "DSH 官方核心";
  if (pkg.startsWith("@linxin666/")) return "UI 全家桶";
  if (pkg.startsWith("@dsh-external/")) return "社区扩展";
  if (pkg.startsWith("@omdsh/")) return "OMDSH 生态";
  if (typeof spec === "string" && spec.startsWith("link:")) return "本地自装";
  if (typeof spec === "string" && spec.startsWith("github:")) return "GitHub 安装";
  return "其他";
}

function apply(ctx) {
  const home = process.env.DSH_HOME || path.join(process.env.HOME || "/root", ".dsh");
  const profileDir = path.join(home, "profiles", "web");
  const notesFile = path.join(home, "plugin-catalog", "notes.json");
  // 内置包（无 spec）从 dsh 主包解析元数据；symlink 下 import.meta.url 会解析错，用固定主包根
  const DSH_MAIN_NODE_MODULES = "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules";

  async function readNotes() {
    try {
      return JSON.parse(await fs.readFile(notesFile, "utf8"));
    } catch {
      return {};
    }
  }

  async function writeNotes(notes) {
    await fs.mkdir(path.dirname(notesFile), { recursive: true });
    await fs.writeFile(notesFile, JSON.stringify(notes, null, 2), "utf8");
  }

  /** 简化 semver 比较：'1.2.3-rc.1' vs '0.9.0' → 1 / -1 / 0 */
  function cmpVersion(a, b) {
    const pa = parseVer(a), pb = parseVer(b);
    for (let i = 0; i < 3; i++) {
      if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
    }
    const ra = pa[3] ?? "", rb = pb[3] ?? "";
    if (ra === rb) return 0;
    if (!ra) return 1;  // 正式版 > prerelease
    if (!rb) return -1;
    return ra < rb ? -1 : 1;
  }
  function parseVer(v) {
    const m = String(v || "").trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4]] : [0, 0, 0, ""];
  }

  /** 并发信号量（npm/git 子进程限流） */
  function makeSemaphore(max) {
    let active = 0;
    const queue = [];
    return (fn) => new Promise((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(() => {
          active--;
          const next = queue.shift();
          if (next) next();
        });
      };
      if (active < max) run();
      else queue.push(run);
    });
  }

  const execFileP = (cmd, args, opts) => new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts?.timeout ?? 8000, cwd: opts?.cwd, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, code: err.code, stdout: String(stdout || ""), stderr: String(stderr || "") });
      else resolve({ ok: true, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });

  /** 版本检查缓存（TTL 5 分钟），update 成功后按 name purge */
  const verCache = new Map(); // name -> { at, data }
  const VER_TTL_MS = 5 * 60 * 1000;
  /** 更新进行中锁：name -> Promise */
  const updateLocks = new Map();

  async function checkVersion(entry) {
    const { name, source } = entry;
    if (!source || source === "内置") {
      return { name, builtin: true, local: entry.version || "", hasUpdate: null };
    }
    // npm 包：spec 形如 ^0.1.20 / ~1.2 / =1.0.0 / 1.2.3
    if (!source.startsWith("link:") && !source.startsWith("github:")) {
      const r = await execFileP("npm", ["view", name, "dist-tags", "--json"], { timeout: 8000 });
      if (!r.ok) return { name, local: entry.version || "", hasUpdate: null, error: "查询失败" };
      let tags = {};
      try { tags = JSON.parse(r.stdout); } catch { return { name, local: entry.version || "", hasUpdate: null, error: "解析失败" }; }
      // 最新 = 全部 dist-tag 中 semver 最大的（覆盖 rc 系包 latest 比 next 旧的情况）
      let latest = "";
      for (const t of Object.keys(tags)) {
        const v = String(tags[t] || "");
        if (!v) continue;
        if (!latest || cmpVersion(v, latest) > 0) latest = v;
      }
      const local = entry.version || "";
      const hasUpdate = latest && local ? cmpVersion(latest, local) > 0 : null;
      return { name, local, latest: latest || "", hasUpdate, source: "npm" };
    }
    // github 包：spec 锁定 commit vs 远端 HEAD
    if (source.startsWith("github:")) {
      const m = source.match(/^github:([^#]+)(?:#([0-9a-f]+))?/);
      if (!m) return { name, local: entry.version || "", hasUpdate: null };
      const specCommit = m[2] || "";
      const repoUrl = "https://github.com/" + m[1] + ".git";
      const r = await execFileP("git", ["ls-remote", repoUrl, "HEAD"], { timeout: 8000 });
      if (!r.ok) return { name, local: entry.version || "", hasUpdate: null, error: "检查受限" };
      const head = (r.stdout.match(/^([0-9a-f]+)\s+HEAD/m) || [])[1] || "";
      return { name, local: entry.version || "", latest: specCommit.slice(0, 7), remoteHead: head ? head.slice(0, 7) : "", hasUpdate: !!(head && specCommit && head !== specCommit), source: "github" };
    }
    // link 包：本地 git 目录，远端 HEAD vs 本地 HEAD
    if (source.startsWith("link:")) {
      const dir = source.slice("link:".length);
      const hasGit = await fs.access(path.join(dir, ".git")).then(() => true).catch(() => false);
      if (!hasGit) return { name, local: entry.version || "", hasUpdate: null, source: "link", note: "本地源码（无 git 跟踪）" };
      const remote = await execFileP("git", ["-C", dir, "remote", "get-url", "origin"], { timeout: 5000 });
      if (!remote.ok || !remote.stdout.trim()) return { name, local: entry.version || "", hasUpdate: null, source: "link", note: "无远端" };
      const [headR, lsR] = await Promise.all([
        execFileP("git", ["-C", dir, "rev-parse", "HEAD"], { timeout: 5000 }),
        execFileP("git", ["ls-remote", remote.stdout.trim(), "HEAD"], { timeout: 8000 }),
      ]);
      const localHead = headR.ok ? headR.stdout.trim() : "";
      const remoteHead = (lsR.stdout.match(/^([0-9a-f]+)\s+HEAD/m) || [])[1] || "";
      return { name, local: entry.version || "", localHead: localHead.slice(0, 7), remoteHead: remoteHead.slice(0, 7), hasUpdate: !!(localHead && remoteHead && localHead !== remoteHead), source: "link" };
    }
    return { name, local: entry.version || "", hasUpdate: null };
  }

  async function handleVersions(entries) {
    const out = [];
    const sem = makeSemaphore(4);
    await Promise.all(entries.map((e) => sem(() => {
      const cached = verCache.get(e.name);
      if (cached && Date.now() - cached.at < VER_TTL_MS) {
        out.push(cached.data);
        return Promise.resolve();
      }
      return checkVersion(e).then((data) => {
        verCache.set(e.name, { at: Date.now(), data });
        out.push(data);
      });
    })));
    return { ok: true, versions: out };
  }

  async function handleUpdate(name, entries) {
    // S3 修订：精确白名单匹配（list 返回的 entries 之一），拒绝一切其他输入
    const entry = entries.find((e) => e.name === name);
    if (!entry) return { ok: false, error: "未知插件" };
    const { source } = entry;
    if (!source || source === "内置") return { ok: false, error: "内置插件不支持更新" };
    if (source.startsWith("link:") || source.startsWith("github:")) {
      return { ok: false, error: "该来源暂不支持一键更新（link/github 包请手动处理，仅提示变更）" };
    }
    if (updateLocks.has(name)) return { ok: false, error: "更新进行中，请稍候" };
    const task = (async () => {
      // 备份（可回滚）
      const bakPkg = path.join(profileDir, "package.json.bak-update");
      const bakLock = path.join(profileDir, "pnpm-lock.yaml.bak-update");
      await fs.copyFile(path.join(profileDir, "package.json"), bakPkg).catch(() => {});
      await fs.copyFile(path.join(profileDir, "pnpm-lock.yaml"), bakLock).catch(() => {});
      // pnpm update 受 package.json range 约束（caret 在 0.x 不允许跨 minor）；
      // 用 pnpm add @latest 更新 spec 并安装，才能真正升到最新
      const r = await execFileP("pnpm", ["add", name + "@latest"], { timeout: 180000, cwd: profileDir });
      if (!r.ok) {
        // 回滚
        await fs.copyFile(bakPkg, path.join(profileDir, "package.json")).catch(() => {});
        await fs.copyFile(bakLock, path.join(profileDir, "pnpm-lock.yaml")).catch(() => {});
        verCache.delete(name);
        return { ok: false, error: "更新失败（已回滚）", output: (r.stdout + r.stderr).slice(-2000) };
      }
      verCache.delete(name);
      return { ok: true, output: (r.stdout + r.stderr).slice(-2000), restart: true };
    })().finally(() => updateLocks.delete(name));
    updateLocks.set(name, task);
    return task;
  }

  async function handleList() {
    const pkgPath = path.join(profileDir, "package.json");
    let profile;
    try {
      profile = JSON.parse(await fs.readFile(pkgPath, "utf8"));
    } catch (err) {
      return { ok: false, error: "profile package.json 读取失败: " + err.message };
    }
    const deps = profile.dependencies || {};
    const bundles = (profile.dsh && profile.dsh.profile && profile.dsh.profile.bundles) || [];
    // 包元数据查找路径：profile node_modules → dsh 主包 node_modules（内置包）
    const candidates = [
      (pkg) => path.join(profileDir, "node_modules", pkg, "package.json"),
      (pkg) => path.join(DSH_MAIN_NODE_MODULES, pkg, "package.json"),
    ];
    const entries = [];
    for (const pkg of bundles) {
      const spec = deps[pkg];
      let meta = { version: "", description: "" };
      for (const cand of candidates) {
        try {
          meta = JSON.parse(await fs.readFile(cand(pkg), "utf8"));
          break;
        } catch {
          /* try next candidate */
        }
      }
      entries.push({
        name: pkg,
        version: meta.version || "",
        description: meta.description || "",
        source: typeof spec === "string" ? spec : "内置",
        kind: classify(pkg, spec),
      });
    }
    const notes = await readNotes();
    return { ok: true, entries, notes };
  }

  const webServer = ctx.get("webServer");
  if (webServer) {
    const routes = [
      {
        kind: "exact",
        path: "/plugin-catalog/api/list",
        handler: async (req, res) => {
          res.setHeader("content-type", "application/json; charset=utf-8");
          try {
            res.end(JSON.stringify(await handleList()));
          } catch (err) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
          }
        },
      },
      {
        kind: "exact",
        path: "/plugin-catalog/api/notes",
        handler: async (req, res) => {
          res.setHeader("content-type", "application/json; charset=utf-8");
          try {
            if (req.method === "GET") {
              res.end(JSON.stringify({ ok: true, notes: await readNotes() }));
              return;
            }
            if (req.method === "PUT") {
              let body = "";
              for await (const chunk of req) body += chunk;
              const input = JSON.parse(body || "{}");
              if (!input || typeof input.pkg !== "string" || !input.pkg) {
                res.statusCode = 400;
                res.end(JSON.stringify({ ok: false, error: "缺少 pkg" }));
                return;
              }
              const notes = await readNotes();
              const cur = notes[input.pkg] || {};
              if (typeof input.note === "string") cur.note = input.note;
              if (typeof input.category === "string") cur.category = input.category;
              notes[input.pkg] = cur;
              await writeNotes(notes);
              res.end(JSON.stringify({ ok: true }));
              return;
            }
            res.statusCode = 405;
            res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
          } catch (err) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
          }
        },
      },
      {
        kind: "exact",
        path: "/plugin-catalog/api/versions",
        handler: async (req, res) => {
          res.setHeader("content-type", "application/json; charset=utf-8");
          try {
            const list = await handleList();
            if (!list.ok) {
              res.end(JSON.stringify(list));
              return;
            }
            res.end(JSON.stringify(await handleVersions(list.entries)));
          } catch (err) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
          }
        },
      },
      {
        kind: "exact",
        path: "/plugin-catalog/api/update",
        handler: async (req, res) => {
          res.setHeader("content-type", "application/json; charset=utf-8");
          try {
            if (req.method !== "POST") {
              res.statusCode = 405;
              res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
              return;
            }
            let body = "";
            for await (const chunk of req) body += chunk;
            const input = JSON.parse(body || "{}");
            const name = String(input.name || "").trim();
            if (!name || name.length > 120) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: "非法插件名" }));
              return;
            }
            const list = await handleList();
            if (!list.ok) {
              res.end(JSON.stringify(list));
              return;
            }
            res.end(JSON.stringify(await handleUpdate(name, list.entries)));
          } catch (err) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
          }
        },
      },
    ];
    for (const route of routes) {
      ctx.effect(() => webServer.register(route), "plugin-catalog: " + route.path + " route");
    }
  } else {
    console.warn("[plugin-catalog] webServer 不可用，HTTP API 未注册");
  }
  console.log("[plugin-catalog] host loaded (list + notes API)");
}

export { apply, inject, name };