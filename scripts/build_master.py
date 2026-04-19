"""
ぽんしゅ館 銘柄マスタ 差分更新スクリプト

公式サイトの各店舗銘柄一覧ページをスクレイピングして、
data/master.json を差分更新します。

動作:
  1. 既存の master.json を読み込み (なければ空から)
  2. 既存データの正規化と重複マージ (NFC正規化、過去の分解形データの救済)
  3. 3店舗の現在メニューをスクレイピング (結果もNFC正規化)
  4. 「酒蔵名 + 銘柄名」でマッチング:
     - 既存にあり、今回もメニューにある  -> ID維持、available_atを更新、retired_atを外す(復活)
     - 既存にあり、今回はメニューにない  -> available_atの該当店に retired_at をセット
     - 新規銘柄                          -> 新ID採番、first_seen をセット
  5. 差分サマリを標準出力に表示

出力フィールド:
  - id (永続)
  - brewery, name (NFC正規化済み)
  - image_url (最新優先)
  - first_seen (初回登場日, 既存データは今日の日付で補完)
  - available_at: [
      { "store": "niigata", "number": "013" },               # 現役
      { "store": "nagaoka", "number": "013", "retired_at": "2026-06-01" }  # 引退
    ]

使い方:
    pip install -r scripts/requirements.txt
    python scripts/build_master.py
"""

import json
import re
import sys
import time
import unicodedata
from datetime import date
from pathlib import Path

import requests
from bs4 import BeautifulSoup

STORES = [
    {"id": "niigata", "name": "新潟驛店", "url": "https://www.ponshukan.com/niigata/kkz/"},
    {"id": "nagaoka", "name": "長岡驛店", "url": "https://www.ponshukan.com/nagaoka/kkz/"},
    {"id": "yuzawa", "name": "越後湯沢驛店", "url": "https://www.ponshukan.com/yuzawa/kkz/"},
]

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
}

NUMBER_PATTERN = re.compile(r"【\s*(\d+)\s*】")

MASTER_PATH = Path(__file__).parent.parent / "data" / "master.json"


# ============================================================
# スクレイピング
# ============================================================

def normalize_text(s):
    """
    Unicode NFKC 正規化 + 引用符/ダッシュ類の揺れ吸収 + 余分な空白の除去。
    ぽんしゅ館のページからは濁点・半濁点の分解形(NFD)で取得されるケースがあり、
    NFC化しないと「バ」と「ハ+゛」が別文字扱いになるため必須。
    また、カーリークォートと ASCII アポストロフィ、全角ダッシュと半角ハイフンなど
    字形ゆらぎを統一する。
    """
    if not s:
        return s
    s = unicodedata.normalize("NFKC", s)
    # 引用符ゆらぎ吸収 (Unicodeのカーリー系 → ASCII)
    s = s.translate(str.maketrans({
        "\u2018": "'",  # LEFT SINGLE QUOTATION MARK
        "\u2019": "'",  # RIGHT SINGLE QUOTATION MARK
        "\u201C": '"',  # LEFT DOUBLE QUOTATION MARK
        "\u201D": '"',  # RIGHT DOUBLE QUOTATION MARK
        "\u2013": "-",  # EN DASH
        "\u2014": "-",  # EM DASH
        "\u30FC": "ー",  # 長音記号は統一
        "\uFF5E": "~",  # FULLWIDTH TILDE
    }))
    s = re.sub(r"\s+", " ", s).strip()
    return s


def fetch_store_sake(store):
    """店舗ページから銘柄リストを抽出"""
    print(f"Fetching {store['name']} ({store['url']}) ...", file=sys.stderr)
    resp = requests.get(store["url"], headers=HEADERS, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    sakes = []
    for li in soup.find_all("li"):
        text = li.get_text("\n", strip=True)
        m = NUMBER_PATTERN.search(text)
        if not m:
            continue

        # 銘柄一覧のliは画像を持つ。ランキングliなどは画像なしなので除外
        img = li.find("img")
        if not img:
            continue

        number = m.group(1)

        lines = []
        for raw_line in text.split("\n"):
            stripped = NUMBER_PATTERN.sub("", raw_line).strip()
            stripped = re.sub(r"\s+", " ", stripped)
            if stripped:
                lines.append(stripped)

        if len(lines) < 2:
            continue

        brewery = normalize_text(lines[0])
        sake_name = normalize_text(lines[1])
        image_url = img.get("src")

        sakes.append({
            "number": number,
            "brewery": brewery,
            "name": sake_name,
            "image_url": image_url,
        })

    print(f"  -> {len(sakes)} sake", file=sys.stderr)
    return sakes


# ============================================================
# マスタ操作
# ============================================================

def load_master():
    """既存マスタを読み込み、なければ空のスケルトンを返す"""
    if MASTER_PATH.exists():
        with MASTER_PATH.open(encoding="utf-8") as f:
            return json.load(f)
    return {
        "updated_at": None,
        "stores": [{"id": s["id"], "name": s["name"]} for s in STORES],
        "sake": [],
    }


def normalize_existing_master(master):
    """
    既存masterのbrewery/nameにNFC正規化をかけ、正規化後に重複するレコードをマージする。
    過去バージョンのスクリプトで生成された NFD 形式のデータを救済するためのマイグレーション。
    マージルール:
      - 同じ正規化キー (brewery, name) を持つ複数レコードがある場合、
        「現役エントリを持つ方」または「より新しいID (番号が大きい方)」を残し、
        もう一方の available_at を吸収する。
      - 吸収時、同じ store_id のエントリがあれば「現役エントリ優先」「数字が大きい retired_at 優先」
    戻り値: 正規化・重複排除済みの master
    """
    # まず brewery/name を正規化
    for s in master["sake"]:
        s["brewery"] = normalize_text(s["brewery"])
        s["name"] = normalize_text(s["name"])

    # 正規化キーで重複検出
    groups = {}
    for s in master["sake"]:
        key = (s["brewery"], s["name"])
        groups.setdefault(key, []).append(s)

    merged_sakes = []
    merges_performed = []

    for key, records in groups.items():
        if len(records) == 1:
            merged_sakes.append(records[0])
            continue

        # 複数レコードを1つにマージ。
        # 勝者の選定ポリシー: **古いID (=ユーザーが既に記録している可能性が高い方) を優先**。
        # IDが同じ数値順でソートして、最小番号を採用する。
        # 同率の場合は first_seen が古い方、最後に辞書順で安定化。
        def sort_key(r):
            id_num = 99999
            m = re.match(r"sake-(\d+)", r.get("id", ""))
            if m:
                id_num = int(m.group(1))
            fs = r.get("first_seen", "9999-99-99")
            return (id_num, fs)

        records_sorted = sorted(records, key=sort_key)
        winner = records_sorted[0]
        losers = records_sorted[1:]

        # losersのavailable_atを吸収。
        # 現役エントリは引退エントリより優先して残す。
        for loser in losers:
            for loser_entry in loser["available_at"]:
                existing = next(
                    (a for a in winner["available_at"] if a["store"] == loser_entry["store"]),
                    None,
                )
                if existing is None:
                    winner["available_at"].append(loser_entry)
                    continue

                # 両方の状態を判定
                existing_retired = "retired_at" in existing
                loser_retired = "retired_at" in loser_entry

                if existing_retired and not loser_retired:
                    # winner側が引退、loser側が現役 -> loser側を採用 (現役優先)
                    existing.pop("retired_at", None)
                    existing["number"] = loser_entry["number"]
                elif not existing_retired and loser_retired:
                    # winner側が現役、loser側が引退 -> そのまま (現役優先)
                    pass
                elif existing_retired and loser_retired:
                    # 両方引退 -> より新しい retired_at を残す
                    if loser_entry["retired_at"] > existing["retired_at"]:
                        existing["retired_at"] = loser_entry["retired_at"]
                        existing["number"] = loser_entry["number"]
                else:
                    # 両方現役 -> 番号が新しい (=より最近の情報) を優先
                    # ただし両方現役で番号が違うのは本来ありえないケース
                    existing["number"] = loser_entry["number"]

            # first_seen は古い方を維持
            if loser.get("first_seen") and loser["first_seen"] < winner.get("first_seen", "9999"):
                winner["first_seen"] = loser["first_seen"]

            # 画像URLは winner のものを優先 (古いID=元から登録されていた方の画像)
            if not winner.get("image_url") and loser.get("image_url"):
                winner["image_url"] = loser["image_url"]

        merges_performed.append({
            "key": key,
            "winner": winner["id"],
            "losers": [loser["id"] for loser in losers],
        })
        merged_sakes.append(winner)

    master["sake"] = merged_sakes
    if merges_performed:
        print(f"\n[migration] 正規化で重複マージ: {len(merges_performed)}件", file=sys.stderr)
        for m in merges_performed:
            print(f"  {m['key']} <- winner={m['winner']}, discarded={m['losers']}", file=sys.stderr)
    return master


def sake_key(brewery, name):
    """銘柄の同一性判定に使うキー (酒蔵+銘柄名の完全一致、正規化済みを期待)"""
    return (normalize_text(brewery), normalize_text(name))


def next_sake_id(existing_sakes):
    """既存の最大ID連番+1 を返す"""
    max_n = 0
    for s in existing_sakes:
        m = re.match(r"sake-(\d+)", s.get("id", ""))
        if m:
            max_n = max(max_n, int(m.group(1)))
    return f"sake-{max_n + 1:04d}"


def apply_diff(master, scraped_by_store):
    """
    既存masterにスクレイピング結果を差分適用する。
    戻り値: (新master, diff_summary dict)
    """
    today = date.today().isoformat()

    # 既存銘柄を (brewery, name) -> record でインデックス化
    index = {sake_key(s["brewery"], s["name"]): s for s in master["sake"]}

    # 差分統計
    diff = {
        "added": [],          # 新規銘柄
        "retired": [],        # どこかの店舗で引退した
        "revived": [],        # 引退から復活した
        "number_changed": [], # 唎酒番号が変わった
        "unchanged": 0,
    }

    # 今回のスクレイピング結果で登場した (key, store_id) のセット
    seen_store_pairs = set()

    for store_id, scraped in scraped_by_store.items():
        for item in scraped:
            key = sake_key(item["brewery"], item["name"])
            seen_store_pairs.add((key, store_id))

            if key in index:
                # 既存銘柄 -> available_at を更新
                sake = index[key]
                entry = next((a for a in sake["available_at"] if a["store"] == store_id), None)

                if entry is None:
                    # この店舗に新登場
                    sake["available_at"].append({
                        "store": store_id,
                        "number": item["number"],
                    })
                    diff["revived"].append({
                        "id": sake["id"],
                        "brewery": sake["brewery"],
                        "name": sake["name"],
                        "store": store_id,
                        "number": item["number"],
                    })
                else:
                    # 既存エントリの更新: 番号変更 / 復活 を検出
                    was_retired = "retired_at" in entry
                    old_number = entry.get("number")

                    if was_retired:
                        entry.pop("retired_at", None)
                        diff["revived"].append({
                            "id": sake["id"],
                            "brewery": sake["brewery"],
                            "name": sake["name"],
                            "store": store_id,
                            "number": item["number"],
                        })

                    if old_number != item["number"]:
                        diff["number_changed"].append({
                            "id": sake["id"],
                            "brewery": sake["brewery"],
                            "name": sake["name"],
                            "store": store_id,
                            "old": old_number,
                            "new": item["number"],
                        })
                        entry["number"] = item["number"]

                    if not was_retired and old_number == item["number"]:
                        diff["unchanged"] += 1

                # 画像URLが空なら補完 (既存URLは温存、古いラベルのまま残しておきたい場合があるため上書きしない)
                if not sake.get("image_url") and item.get("image_url"):
                    sake["image_url"] = item["image_url"]
            else:
                # 新規銘柄
                new_id = next_sake_id(list(index.values()) + [])
                new_sake = {
                    "id": new_id,
                    "brewery": item["brewery"],
                    "name": item["name"],
                    "image_url": item["image_url"],
                    "first_seen": today,
                    "available_at": [{
                        "store": store_id,
                        "number": item["number"],
                    }],
                }
                index[key] = new_sake
                diff["added"].append({
                    "id": new_id,
                    "brewery": item["brewery"],
                    "name": item["name"],
                    "store": store_id,
                    "number": item["number"],
                })

    # 既存のうち、今回のスクレイピングで見なかった (key, store) の組み合わせ -> その店舗で引退
    for key, sake in index.items():
        for entry in sake["available_at"]:
            if (key, entry["store"]) not in seen_store_pairs and "retired_at" not in entry:
                entry["retired_at"] = today
                diff["retired"].append({
                    "id": sake["id"],
                    "brewery": sake["brewery"],
                    "name": sake["name"],
                    "store": entry["store"],
                    "number": entry.get("number"),
                })

    # 既存データのマイグレーション: first_seen がない銘柄に今日の日付を補完
    # (初回実行で既存のmaster.jsonを読み込んだときに一度だけ走る)
    for sake in index.values():
        if "first_seen" not in sake:
            sake["first_seen"] = today

    # 最終構築: 酒蔵+銘柄名でソート
    sake_list = sorted(index.values(), key=lambda x: (x["brewery"], x["name"]))

    # フィールド順序を安定化
    cleaned = []
    for s in sake_list:
        cleaned.append({
            "id": s["id"],
            "brewery": s["brewery"],
            "name": s["name"],
            "image_url": s.get("image_url"),
            "first_seen": s["first_seen"],
            "available_at": _sorted_available_at(s["available_at"]),
        })

    new_master = {
        "updated_at": today,
        "stores": [{"id": s["id"], "name": s["name"]} for s in STORES],
        "sake": cleaned,
    }
    return new_master, diff


def _sorted_available_at(entries):
    """available_at を店舗順 (niigata, nagaoka, yuzawa) でソート"""
    order = {s["id"]: i for i, s in enumerate(STORES)}
    return sorted(
        [
            {k: v for k, v in e.items() if v is not None}
            for e in entries
        ],
        key=lambda e: order.get(e["store"], 999),
    )


def print_diff_summary(diff):
    """差分サマリを標準出力に"""
    print("\n" + "=" * 60)
    print("差分サマリ")
    print("=" * 60)

    if diff["added"]:
        print(f"\n✨ 新規追加: {len(diff['added'])}件")
        for a in diff["added"][:20]:
            print(f"   [{a['id']}] {a['brewery']} / {a['name']} ({a['store']} {a['number']})")
        if len(diff["added"]) > 20:
            print(f"   ...他 {len(diff['added']) - 20}件")

    if diff["retired"]:
        print(f"\n🍂 引退: {len(diff['retired'])}件")
        for r in diff["retired"][:20]:
            print(f"   [{r['id']}] {r['brewery']} / {r['name']} ({r['store']} {r['number']})")
        if len(diff["retired"]) > 20:
            print(f"   ...他 {len(diff['retired']) - 20}件")

    if diff["revived"]:
        print(f"\n🌱 復活: {len(diff['revived'])}件")
        for r in diff["revived"][:20]:
            print(f"   [{r['id']}] {r['brewery']} / {r['name']} ({r['store']} {r['number']})")
        if len(diff["revived"]) > 20:
            print(f"   ...他 {len(diff['revived']) - 20}件")

    if diff["number_changed"]:
        print(f"\n🔀 唎酒番号変更: {len(diff['number_changed'])}件")
        for c in diff["number_changed"][:20]:
            print(f"   [{c['id']}] {c['brewery']} / {c['name']} ({c['store']} 【{c['old']}】 -> 【{c['new']}】)")
        if len(diff["number_changed"]) > 20:
            print(f"   ...他 {len(diff['number_changed']) - 20}件")

    total_changes = (
        len(diff["added"]) + len(diff["retired"])
        + len(diff["revived"]) + len(diff["number_changed"])
    )
    if total_changes == 0:
        print("\n(変更なし)")
    print()


def main():
    master = load_master()
    print(f"既存マスタ: {len(master['sake'])}銘柄 (updated_at: {master.get('updated_at')})",
          file=sys.stderr)

    # 既存データの正規化と重複マージ (過去のNFD形式データを救済)
    master = normalize_existing_master(master)

    scraped_by_store = {}
    for store in STORES:
        scraped_by_store[store["id"]] = fetch_store_sake(store)
        time.sleep(2)  # マナー: リクエスト間隔

    new_master, diff = apply_diff(master, scraped_by_store)

    MASTER_PATH.parent.mkdir(parents=True, exist_ok=True)
    with MASTER_PATH.open("w", encoding="utf-8") as f:
        json.dump(new_master, f, ensure_ascii=False, indent=2)

    print_diff_summary(diff)

    print(f"Wrote {MASTER_PATH}", file=sys.stderr)
    print(f"  total sake (含引退): {len(new_master['sake'])}", file=sys.stderr)
    active_total = sum(
        1 for s in new_master["sake"]
        if any("retired_at" not in a for a in s["available_at"])
    )
    print(f"  active (現役): {active_total}", file=sys.stderr)

    print("\n店舗別 現役銘柄数:", file=sys.stderr)
    for store in STORES:
        count = sum(
            1 for s in new_master["sake"]
            for a in s["available_at"]
            if a["store"] == store["id"] and "retired_at" not in a
        )
        print(f"  {store['name']}: {count}", file=sys.stderr)


if __name__ == "__main__":
    main()
