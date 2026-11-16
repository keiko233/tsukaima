#!/usr/bin/env python3
"""One-shot data migration: rename `elaina` runtime identifiers to `tsukaima`
inside existing dev SQLite databases. Chat text and other natural-language
content are left untouched; only schema names and exact runtime key patterns
are rewritten. Run once from the repo root: `bun tools/ops/rename-data.ts`-style
usage not required, plain python3 is enough."""
import shutil
import sqlite3
import sys
from pathlib import Path

# Exact runtime identifier patterns written by (renamed) code. All patterns are
# mutually non-overlapping and distinctive enough that chat text will never
# contain them.
KEY_PATTERNS = [
    ("elaina-context", "tsukaima-context"),
    ("elaina-persona", "tsukaima-persona"),
    ("elaina-policy", "tsukaima-policy"),
    ("elaina-memory", "tsukaima-memory"),
    ("elaina.conversationPolicy", "tsukaima.conversationPolicy"),
    ("elaina.activityWindow", "tsukaima.activityWindow"),
    ("elaina.messageReceipt", "tsukaima.messageReceipt"),
    ("elaina-plugin-tools", "tsukaima-plugin-tools"),
]


def replace_expr(col: str) -> str:
    expr = col
    for old, new in KEY_PATTERNS:
        expr = f"REPLACE({expr}, '{old}', '{new}')"
    return expr


def q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def migrate(path: str) -> None:
    file = Path(path)
    if not file.exists():
        print(f"skip (missing): {path}")
        return
    backup = file.with_suffix(file.suffix + ".pre-rename.bak")
    if not backup.exists():
        shutil.copy2(file, backup)
        print(f"backup: {backup}")
    conn = sqlite3.connect(file)
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.execute("PRAGMA foreign_keys=OFF")
    cur = conn.cursor()

    tables = [
        r[0]
        for r in cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%elaina%'"
        )
    ]
    counts = {}
    cur.execute("BEGIN")
    # 1. Rename tables (auto-indexes follow automatically).
    for t in tables:
        new = t.replace("elaina", "tsukaima")
        cur.execute(f"ALTER TABLE {q(t)} RENAME TO {q(new)}")
        counts[new] = cur.execute(f"SELECT count(*) FROM {q(new)}").fetchone()[0]
    # 2. Rebuild named indexes under new names (SQLite has no ALTER INDEX RENAME).
    indexes = list(
        cur.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='index' "
            "AND name LIKE '%elaina%' AND sql IS NOT NULL"
        )
    )
    for name, sql in indexes:
        cur.execute(f"DROP INDEX {q(name)}")
        cur.execute(sql.replace("elaina", "tsukaima"))
    # 3. Rewrite runtime key patterns in TEXT columns only, and only in cells
    #    that contain a pattern-shaped prefix (`elaina-` or `elaina.`), so
    #    message bodies and chat content are never rewritten.
    for t in (t.replace("elaina", "tsukaima") for t in tables):
        info = list(cur.execute(f"PRAGMA table_info({q(t)})"))
        for _cid, col, ctype, *_rest in info:
            if ctype.upper() != "TEXT":
                continue
            cond = f"{q(col)} LIKE '%elaina-%' OR {q(col)} LIKE '%elaina.%'"
            cur.execute(
                f"UPDATE {q(t)} SET {q(col)} = {replace_expr(q(col))} WHERE {cond}"
            )
    cur.execute("COMMIT")
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    ok = cur.execute("PRAGMA integrity_check").fetchone()[0]
    # Post-check: no runtime key pattern left behind.
    leftovers = 0
    for t in (t.replace("elaina", "tsukaima") for t in tables):
        info = list(cur.execute(f"PRAGMA table_info({q(t)})"))
        for _cid, col, ctype, *_rest in info:
            if ctype.upper() != "TEXT":
                continue
            for old, _new in KEY_PATTERNS:
                leftovers += cur.execute(
                    f"SELECT count(*) FROM {q(t)} WHERE instr({q(col)}, ?) > 0",
                    (old,),
                ).fetchone()[0]
    conn.close()
    print(
        f"migrated: {path}  tables={len(tables)}  rows="
        + ",".join(f"{k}:{v}" for k, v in sorted(counts.items()))
        + f"  integrity={ok}  key_leftovers={leftovers}"
    )
    if ok != "ok" or leftovers:
        sys.exit(1)


def migrate_domain(path: str) -> None:
    """Domain DB: only exact bot-identity and admin-email values; message
    bodies (`content_text`, `parts_json`, `raw_ref_json`) are never touched."""
    file = Path(path)
    backup = file.with_suffix(file.suffix + ".pre-rename.bak")
    if not backup.exists():
        shutil.copy2(file, backup)
        print(f"backup: {backup}")
    conn = sqlite3.connect(file)
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    cur = conn.cursor()
    cur.execute("BEGIN")
    n1 = cur.execute(
        "UPDATE messages SET sender_external_id='tsukaima' WHERE sender_external_id='elaina'"
    ).rowcount
    n2 = cur.execute(
        "UPDATE messages SET sender_display_name='Tsukaima' "
        "WHERE sender_display_name='Elaina' AND sender_external_id='tsukaima'"
    ).rowcount
    n3 = cur.execute(
        "UPDATE auth_user SET email='admin@tsukaima.invalid' WHERE email='admin@elaina.invalid'"
    ).rowcount
    cur.execute("COMMIT")
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    ok = cur.execute("PRAGMA integrity_check").fetchone()[0]
    left_sender = cur.execute(
        "SELECT count(*) FROM messages WHERE sender_external_id LIKE '%elaina%'"
    ).fetchone()[0]
    conn.close()
    print(
        f"migrated: {path}  sender_external_id={n1}  sender_display_name={n2}  "
        f"admin_email={n3}  integrity={ok}  sender_leftovers={left_sender}"
    )
    if ok != "ok" or left_sender:
        sys.exit(1)


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent.parent
    for rel in ("data/durable.sqlite", "apps/server/data/durable.sqlite", "apps/server/data/cache.sqlite"):
        migrate(str(root / rel))
    for rel in (
        "apps/server/data/plugins/sticker_meme.sqlite",
        "apps/server/data/plugins/proactive_scheduler.sqlite",
    ):
        migrate(str(root / rel))
    migrate_domain(str(root / "apps/server/data/domain.sqlite"))
    print("done")
