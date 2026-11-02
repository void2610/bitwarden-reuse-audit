// rotator への命令を 1 件送り、応答を表示する
import net from "node:net";
import path from "node:path";
import os from "node:os";

const SOCK = process.env.ROT_SOCK || path.join(os.tmpdir(), "bw-rotator.sock");
const conn = net.createConnection(SOCK, () => conn.write(process.argv[2] + "\n"));
let buf = "";
conn.on("data", (d) => (buf += d));
conn.on("end", () => {
  const res = JSON.parse(buf);
  // 失敗を終了コードで返し、&& でつないだ後続 (commit 等) を止める
  if (!res.ok) process.exitCode = 1;
  if (res.ok && res.result?.elements) {
    const { url, title, text, elements } = res.result;
    console.log(`URL: ${url}\nTITLE: ${title}\n--- text ---\n${text}\n--- elements ---`);
    for (const e of elements) {
      const desc = [e.type, e.name && `name=${e.name}`, e.id && `id=${e.id}`, e.placeholder && `ph=${e.placeholder}`, e.autocomplete && `ac=${e.autocomplete}`, e.label && `label=${e.label}`, e.text && `"${e.text}"`, e.href && `href=${e.href}`, e.filled !== undefined && `filled=${e.filled}`]
        .filter(Boolean)
        .join(" ");
      console.log(`${e.ref} ${e.tag} ${desc}`);
    }
  } else {
    console.log(JSON.stringify(res));
  }
});
conn.on("error", (e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exitCode = 1;
});
