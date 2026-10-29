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
