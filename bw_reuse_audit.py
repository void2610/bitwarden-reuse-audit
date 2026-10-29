#!/usr/bin/env python3
# 使い回しパスワードの棚卸し: 平文もハッシュも書き出さず、グループ番号とメタデータだけを出力する
import json
import os
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from urllib.parse import urlsplit

LOGIN_TYPE = 1


def bw(args, session=None):
    env = dict(os.environ)
    if session:
        # --session 引数だと ps から鍵が見えるため環境変数で渡す
        env["BW_SESSION"] = session
    result = subprocess.run(["bw", *args], env=env, stdout=subprocess.PIPE, text=True)
    if result.returncode != 0:
        sys.exit(f"bw {args[0]} が失敗しました (終了コード {result.returncode})")
    return result.stdout


def host_of(uri):
    if not uri:
        return None
    host = urlsplit(uri if "://" in uri else f"https://{uri}").hostname
    if host and host.startswith("www."):
        host = host[4:]
    return host


def main():
    if len(sys.argv) != 2:
        sys.exit("使い方: bw_reuse_audit.py <出力 JSON のパス>")
    out_path = sys.argv[1]

    status = json.loads(bw(["status"]))["status"]
    if status == "unauthenticated":
        sys.exit("先に `bw login` を実行してください")

    # マスターパスワードの入力は bw が端末から直接受け取る
    session = bw(["unlock", "--raw"]).strip()
    try:
        bw(["sync"], session)
        items = json.loads(bw(["list", "items"], session))
    finally:
        bw(["lock"], session)

    groups = defaultdict(list)
    login_count = 0
    for item in items:
        login = item.get("login") or {}
        password = login.get("password")
        if item.get("type") != LOGIN_TYPE or not password:
            continue
        login_count += 1
        hosts = sorted({h for u in login.get("uris") or [] if (h := host_of(u.get("uri")))})
        groups[password].append({
            "id": item["id"],
            "name": item["name"],
            "hosts": hosts,
            "password_revised": login.get("passwordRevisionDate") or item.get("revisionDate"),
        })
    del items

    reused = sorted(
        (members for members in groups.values() if len(members) >= 2),
        key=lambda members: (-len(members), members[0]["name"].lower()),
    )
    del groups

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "login_items": login_count,
        "reused_groups": [{"group": i, "items": members} for i, members in enumerate(reused, 1)],
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print(f"ログイン {login_count} 件中、使い回しグループ {len(reused)} 組を {out_path} に書き出しました")


if __name__ == "__main__":
    main()
