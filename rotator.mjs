// パスワード変更用の常駐プロセス: 秘密はこのプロセスのメモリにだけ置き、ソケットの応答には一切含めない
import { spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { chromium } from "playwright-core";

const DIR = process.env.ROT_STATE_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), ".state");
const BW = process.env.BW_BIN || "bw";
const CHROME = process.env.CHROME_PATH || undefined;
// macOS の Unix ソケットはパス長が 104 文字までなので短い一時ディレクトリに置く
const SOCK = process.env.ROT_SOCK || path.join(os.tmpdir(), "bw-rotator.sock");
const LOG = path.join(DIR, "rotator.log");

let session = "";
const items = new Map();
const pending = new Map();

function log(msg) {
  fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
}

// 認証コード等は起動した端末で本人が直接入力し、命令を送る側には返さない
function promptTTY(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => s.includes(question) && rl.output.write(s);
    rl.question(`\x07${question}`, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

function bw(args, { input, interactive = false } = {}) {
  const env = { ...process.env, BW_SESSION: session, BW_NOINTERACTION: interactive ? "" : "true" };
  const r = spawnSync(BW, args, {
    env,
    input,
    encoding: "utf8",
    stdio: interactive ? ["inherit", "pipe", "inherit"] : ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`bw ${args[0]} failed (${r.status})`);
  return r.stdout;
}

function findItem(key) {
  if (items.has(key)) return items.get(key);
  const hits = [...items.values()].filter((it) => it.id.startsWith(key));
  if (hits.length !== 1) throw new Error(`item ${key}: ${hits.length} matches`);
  return hits[0];
}

function loadItems() {
  items.clear();
  for (const it of JSON.parse(bw(["list", "items"]))) if (it.type === 1) items.set(it.id, it);
}

async function unlock() {
  const status = JSON.parse(bw(["status"])).status;
  if (status === "unauthenticated") {
    console.log("Bitwarden にログインします");
    bw(["login"], { interactive: true });
  }
  console.log("金庫を開くためにマスターパスワードを入力してください");
  session = bw(["unlock", "--raw"], { interactive: true }).trim();
  bw(["sync"]);
  loadItems();
  console.log(`準備ができました (ログイン ${items.size} 件)。このウィンドウは開いたままにしてください`);
}

let context;
let page;

async function startBrowser() {
  context = await chromium.launchPersistentContext(path.join(DIR, "profile"), {
    executablePath: CHROME,
    headless: true,
    locale: "ja-JP",
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  page = context.pages()[0] ?? (await context.newPage());
  context.on("page", (p) => {
    page = p;
  });
}

// 入力欄の value は読まない。参照用の印だけ付けて、種類と表示文字を返す
async function snapshot() {
  const frames = page.frames();
  const elements = [];
  for (const [fi, frame] of frames.entries()) {
    let list = [];
    try {
      list = await frame.evaluate((fi) => {
        const out = [];
        let n = 0;
        // 前回振った番号が非表示になった要素に残ると、今回の番号と重なる
        for (const el of document.querySelectorAll("[data-rot]")) el.removeAttribute("data-rot");
        const vis = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
        };
        for (const el of document.querySelectorAll("input, button, a, select, textarea, [role=button]")) {
          if (!vis(el)) continue;
          const tag = el.tagName.toLowerCase();
          const type = (el.getAttribute("type") || "").toLowerCase();
          if (tag === "input" && ["hidden"].includes(type)) continue;
          const ref = `f${fi}e${n++}`;
          el.setAttribute("data-rot", ref);
          const label =
            el.getAttribute("aria-label") ||
            (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) ||
            el.closest("label")?.innerText ||
            "";
          const text = tag === "input" || tag === "textarea" ? "" : (el.innerText || el.getAttribute("value") || "").trim();
          out.push({
            ref,
            tag,
            type,
            name: el.getAttribute("name") || "",
            id: el.id || "",
            placeholder: el.getAttribute("placeholder") || "",
            autocomplete: el.getAttribute("autocomplete") || "",
            label: label.trim().slice(0, 60),
            text: text.replace(/\s+/g, " ").slice(0, 60),
            href: tag === "a" ? (el.getAttribute("href") || "").slice(0, 120) : "",
            filled: tag === "input" || tag === "textarea" ? el.value.length > 0 : undefined,
          });
        }
        return out;
      }, fi);
    } catch {
      continue;
    }
    elements.push(...list);
  }
  const text = (await page.evaluate(() => document.body?.innerText || "").catch(() => "")).replace(/\n{2,}/g, "\n").slice(0, 2500);
  return { url: page.url(), title: await page.title(), text, elements };
}

function locator(ref) {
  const fi = Number(ref.match(/^f(\d+)e/)[1]);
  return page.frames()[fi].locator(`[data-rot="${ref}"]`);
}

function genPassword(opts) {
  const args = ["generate", "-uln", "--length", String(opts.length ?? 20)];
  if (opts.symbols !== false) args.push("-s");
  return bw(args).trim();
}

const handlers = {
  async goto({ url }) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1500);
    return { url: page.url(), title: await page.title() };
  },
  snap: snapshot,
  async click({ ref }) {
    await locator(ref).click({ timeout: 15000 });
    await page.waitForTimeout(1500);
    return { url: page.url(), title: await page.title() };
  },
  async fill({ ref, text }) {
    await locator(ref).fill(text);
    return { ok: true };
  },
  async secret({ ref, item, field }) {
    const it = findItem(item);
    const value =
      field === "username" ? it.login.username : field === "password" ? it.login.password : field === "new" ? pending.get(it.id) : null;
    if (!value) throw new Error(`no ${field} for ${it.name}`);
    await locator(ref).fill(value);
    return { ok: true, item: it.name, field };
  },
  async press({ key }) {
    await page.keyboard.press(key);
    await page.waitForTimeout(1500);
    return { url: page.url(), title: await page.title() };
  },
  async gen({ item, length, symbols }) {
    const it = findItem(item);
    pending.set(it.id, genPassword({ length, symbols }));
    return { ok: true, item: it.name, length: pending.get(it.id).length };
  },
  // サイトへ送信する前に保管庫へ保存する。旧パスワードは履歴に残すので、失敗しても戻せる
  async commit({ item }) {
    const it = findItem(item);
    const next = pending.get(it.id);
    if (!next) throw new Error("no pending password");
    const cur = JSON.parse(bw(["get", "item", it.id]));
    const old = cur.login.password;
    cur.login.password = next;
    cur.passwordHistory = [{ lastUsedDate: new Date().toISOString(), password: old }, ...(cur.passwordHistory || [])].slice(0, 5);
    const encoded = bw(["encode"], { input: JSON.stringify(cur) }).trim();
    const saved = JSON.parse(bw(["edit", "item", it.id, encoded]));
    items.set(it.id, saved);
    log(`commit ${it.id} ${it.name}`);
    return { ok: true, item: it.name, revisionDate: saved.revisionDate };
  },
  async revert({ item }) {
    const it = findItem(item);
    const cur = JSON.parse(bw(["get", "item", it.id]));
    const prev = cur.passwordHistory?.[0]?.password;
    if (!prev) throw new Error("no history");
    cur.login.password = prev;
    cur.passwordHistory = cur.passwordHistory.slice(1);
    const encoded = bw(["encode"], { input: JSON.stringify(cur) }).trim();
    const saved = JSON.parse(bw(["edit", "item", it.id, encoded]));
    items.set(it.id, saved);
    log(`revert ${it.id} ${it.name}`);
    return { ok: true, item: it.name };
  },
  async shot() {
    const p = path.join(DIR, "shot.png");
    await page.screenshot({ path: p });
    return { path: p };
  },
  async wait({ ms }) {
    await page.waitForTimeout(ms ?? 2000);
    return { url: page.url(), title: await page.title() };
  },
  async ask({ ref, prompt, hidden = true }) {
    const value = await promptTTY(`${prompt}: `, hidden);
    if (!value) throw new Error("empty answer");
    await locator(ref).fill(value);
    return { ok: true };
  },
  // 規約への同意など本人の判断が要る操作は、端末で yes と答えたときだけ押す
  async confirm({ ref, prompt }) {
    const answer = await promptTTY(`${prompt} (yes/no): `, false);
    if (answer !== "yes") return { ok: false, declined: true };
    await locator(ref).click({ timeout: 15000 });
    await page.waitForTimeout(1500);
    return { ok: true, title: await page.title() };
  },
  // 再設定リンクはトークンを含むので、開いた先の URL は返さない
  async askurl({ prompt }) {
    const url = await promptTTY(`${prompt}: `, true);
    if (!/^https:\/\//.test(url)) throw new Error("not an https url");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1500);
    return { ok: true, title: await page.title() };
  },
  async info({ item }) {
    const it = findItem(item);
    return { id: it.id, name: it.name, uris: (it.login.uris || []).map((u) => u.uri), hasTotp: !!it.login.totp };
  },
};

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.rmSync(SOCK, { force: true });
  // 動作確認用に金庫を開かずブラウザだけ動かす
  if (!process.env.ROT_DRYRUN) await unlock();
  await startBrowser();
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", async (d) => {
      buf += d;
      if (!buf.endsWith("\n")) return;
      let res;
      try {
        const req = JSON.parse(buf);
        res = { ok: true, result: await handlers[req.cmd](req) };
      } catch (e) {
        res = { ok: false, error: String(e.message).slice(0, 300) };
      }
      conn.end(JSON.stringify(res) + "\n");
    });
  });
  server.listen(SOCK, () => fs.chmodSync(SOCK, 0o600));
  const stop = async () => {
    try {
      bw(["lock"]);
    } catch {}
    await context?.close();
    fs.rmSync(SOCK, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e.message);
  // 金庫を開いた後にブラウザの起動等で落ちても、開いたまま残さない
  try {
    bw(["lock"]);
  } catch {}
  process.exit(1);
});
