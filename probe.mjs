// rotator を使って各サイトへのログインを試し、どこで止まったかだけを表示する
import net from "node:net";
import os from "node:os";
import path from "node:path";

const SOCK = process.env.ROT_SOCK || path.join(os.tmpdir(), "bw-rotator.sock");

function call(req) {
  return new Promise((resolve) => {
    const conn = net.createConnection(SOCK, () => conn.write(JSON.stringify(req) + "\n"));
    let buf = "";
    conn.on("data", (d) => (buf += d));
    conn.on("end", () => resolve(JSON.parse(buf)));
    conn.on("error", (e) => resolve({ ok: false, error: e.message }));
  });
}

const isPassword = (e) => e.tag === "input" && e.type === "password";
const isUser = (e) =>
  e.tag === "input" &&
  ["text", "email", "tel", ""].includes(e.type) &&
  /user|mail|login|account|id|subject|member/i.test(`${e.name} ${e.id} ${e.autocomplete} ${e.placeholder} ${e.label}`) &&
  !/search|query|^q$/i.test(`${e.name} ${e.id}`);

async function snap() {
  const r = await call({ cmd: "snap" });
  return r.ok ? r.result : { url: "", title: "", text: r.error, elements: [] };
}

async function probe(item, url) {
  const g = await call({ cmd: "goto", url });
  if (!g.ok) return `goto failed: ${g.error.slice(0, 120)}`;
  await call({ cmd: "wait", ms: 2500 });
  let s = await snap();
  for (let step = 0; step < 2; step++) {
    const pw = s.elements.find(isPassword);
    const user = s.elements.find(isUser);
    if (user && !user.filled) await call({ cmd: "secret", ref: user.ref, item, field: "username" });
    if (pw) {
      await call({ cmd: "secret", ref: pw.ref, item, field: "password" });
      await call({ cmd: "press", key: "Enter" });
      await call({ cmd: "wait", ms: 4000 });
      s = await snap();
      break;
    }
    if (!user) break;
    await call({ cmd: "press", key: "Enter" });
    await call({ cmd: "wait", ms: 3000 });
    s = await snap();
  }
  const stillPw = s.elements.some(isPassword);
  return `${stillPw ? "PW欄あり" : "PW欄なし"} | ${s.title.slice(0, 50)} | ${s.url.slice(0, 80)} | ${s.text.replace(/\s+/g, " ").slice(0, 160)}`;
}

for (const arg of process.argv.slice(2)) {
  const [item, url] = arg.split("=", 2).length === 2 ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, ""];
  console.log(`${item}: ${await probe(item, url)}`);
}
