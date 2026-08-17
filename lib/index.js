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
    const dshPkgRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname));
    const candidates = [
      (pkg) => path.join(profileDir, "node_modules", pkg, "package.json"),
      (pkg) => path.join(dshPkgRoot, "node_modules", pkg, "package.json"),
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