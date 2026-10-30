# bitwarden-reuse-audit

Bitwarden の金庫から、同じパスワードを使い回しているログインを洗い出すスクリプトです。
平文のパスワードもそのハッシュも書き出さず、グループ番号とメタデータだけを JSON に出力します。

## 必要なもの

- Python 3.8 以降
- [Bitwarden CLI](https://bitwarden.com/help/cli/) (`bw`)

## 使い方

```sh
# 初回のみ
bw login

python3 -I bw_reuse_audit.py ~/report.json
```

`bw` を入れずに使う場合は、Nix で一時的に呼び出せます。

```sh
nix shell nixpkgs#bitwarden-cli -c bw login
nix shell nixpkgs#bitwarden-cli -c python3 -I bw_reuse_audit.py ~/report.json
```

マスターパスワードは `bw unlock` が端末から直接受け取ります。
出力にはアイテム名とホスト名が含まれるので、このリポジトリの外に書き出してください。

## 動作

1. `bw unlock` で金庫を開き、`bw sync` で最新の状態にする
2. `bw list items` の結果をメモリ上でパスワードごとにまとめる
3. 2 件以上が同じパスワードのグループだけを書き出す
4. 最後に必ず `bw lock` する

セッションキーは `ps` から見えないよう、引数ではなく環境変数 `BW_SESSION` で `bw` に渡します。

## 出力

```json
{
 "generated_at": "2026-10-29T08:08:11+00:00",
 "login_items": 4,
 "reused_groups": [
  {
   "group": 1,
   "items": [
    {"id": "…", "name": "GitHub", "hosts": ["github.com"], "password_revised": "2020-01-01T00:00:00Z"},
    {"id": "…", "name": "Amazon", "hosts": ["amazon.co.jp"], "password_revised": null}
   ]
  }
 ]
}
```

同じサイトの重複登録と、別のサイト間の使い回しは区別せずに出力します。

## パスワードの変更 (rotator)

`rotator.mjs` は、画面に出ない Chromium をソケット経由の命令で操作し、各サイトのパスワードを変更する常駐プロセスです。
パスワードの値はこのプロセスのメモリにだけ置き、命令への応答には含めません。
命令を送る側 (人や AI エージェント) は、保管庫のアイテム ID を指定するだけで値を扱いません。

### 起動

```sh
npm install
# Chromium が無ければ取得する。既存のものを使う場合は CHROME_PATH を指定する
npx playwright-core install chromium
node rotator.mjs
```

起動した端末でマスターパスワードを入力すると、ソケットで命令を待ち受けます。

| 環境変数 | 既定値 | 用途 |
|---|---|---|
| `BW_BIN` | `bw` | Bitwarden CLI の場所 |
| `CHROME_PATH` | Playwright の Chromium | 使うブラウザの実行ファイル |
| `ROT_SOCK` | `$TMPDIR/bw-rotator.sock` | 命令を受けるソケット |
| `ROT_STATE_DIR` | `./.state` | ブラウザのプロファイルとログ |

### 命令

`node rot.mjs '<JSON>'` で 1 件ずつ送ります。

| 命令 | 例 | 動作 |
|---|---|---|
| `goto` | `{"cmd":"goto","url":"https://example.com/login"}` | ページを開く |
| `snap` | `{"cmd":"snap"}` | 入力欄やボタンの一覧を返す (入力値は返さない) |
| `click` | `{"cmd":"click","ref":"f0e12"}` | 要素を押す |
| `fill` | `{"cmd":"fill","ref":"f0e1","text":"..."}` | 秘密ではない文字を入れる |
| `secret` | `{"cmd":"secret","ref":"f0e10","item":"a95ebfba","field":"password"}` | 保管庫の値を入れる (`username` / `password` / `new`) |
| `gen` | `{"cmd":"gen","item":"a95ebfba","length":20}` | 新しいパスワードを生成して保留する |
| `commit` | `{"cmd":"commit","item":"a95ebfba"}` | 保留中の新しいパスワードを保管庫に保存する |
| `revert` | `{"cmd":"revert","item":"a95ebfba"}` | 直前のパスワードに戻す |
| `press` / `wait` / `shot` / `info` | | キー入力・待機・スクリーンショット・アイテムの名前と URI |

新しいパスワードは、サイトに送信する前に `commit` で保管庫へ保存します。
旧パスワードはアイテムのパスワード履歴に残すので、サイト側の変更が失敗しても `revert` で戻せます。
終了 (`Ctrl+C`) すると `bw lock` してから止まります。
