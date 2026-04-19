# 利き酒手帖 — ぽんしゅ館 記録アプリ

ぽんしゅ館（新潟駅 / 長岡駅 / 越後湯沢駅）の唎酒番所で呑んだ銘柄を記録する、個人用のシンプルなWebアプリ。GitHub Pagesで公開してスマホから使う前提で作られています。

## 特徴

- 📖 3店舗すべての銘柄マスタ（計158銘柄）を収録
- 🏷 店舗別の唎酒番号順で並び、壁の順と一致するので探しやすい
- ⭐ 5段階評価 + 自由メモ + 飲んだ日時/店舗の記録
- 📊 店舗別の制覇率を表示（現役 / 全期間の二本立て）
- 🍂 メニュー終了銘柄も「終了」バッジで表示、過去の記録は残る
- 🔁 GitHub Actions で月1回マスタを自動更新（銘柄の入れ替わりに追従）
- ☁️ GitHub API経由でリポジトリに直接記録を保存（端末間で共有可）
- 📴 PWA化済。ホーム画面追加＆オフラインでUIが開く
- 🍶 日本酒ラベルの雰囲気に合わせた和モダンUI

## 構成

```
ponshukan-tracker/
├── index.html              # エントリ
├── css/style.css
├── js/
│   ├── storage.js          # localStorage ラッパ
│   ├── github-api.js       # GitHub Contents API
│   └── app.js              # メインロジック
├── data/
│   ├── master.json         # 銘柄マスタ（スクリプトで生成、Git管理）
│   └── records.json        # 飲んだ記録（アプリが自動でコミット）
├── scripts/
│   ├── build_master.py     # マスタ生成スクリプト
│   └── requirements.txt
├── .github/workflows/
│   └── update-master.yml   # 月1回の自動マスタ更新
├── manifest.json           # PWA
├── service-worker.js       # オフライン対応
├── icon.svg
└── README.md
```

## セットアップ

### 1. リポジトリを用意する

このプロジェクトをGitHubに**Publicリポジトリ**としてpushする。

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/<yourname>/<repo>.git
git push -u origin main
```

### 2. GitHub Pages を有効化する

リポジトリの Settings → Pages → Source を `Deploy from a branch` にして、`main` / `/ (root)` を選択。数分で `https://<yourname>.github.io/<repo>/` で公開される。

### 3. Personal Access Token (PAT) を作る

1. GitHub の [Developer settings → Fine-grained tokens](https://github.com/settings/tokens?type=beta) から **New token** 。
2. Repository access を **Only select repositories** にして、このリポジトリだけを指定。
3. Permissions → Repository permissions → **Contents** を `Read and write` に。
4. 作成したトークン (`github_pat_...`) をコピー（画面を閉じると見えなくなるので注意）。

### 4. アプリを開いて設定を入れる

公開URLをスマホで開き、右上の⚙（設定）から：

- **Owner / Repo**: `yourname/repo-name`
- **Branch**: `main`
- **Personal Access Token**: さっき作ったPAT

「保存」→「接続テスト」で `接続OK (...)` と出ればOK。

### 5. 記録を始める

店舗 → 銘柄 → ☆評価とメモを入れて「この一杯を綴る」を押すと、ローカル保存 + GitHub への自動コミットが走る。

## マスタの更新

ぽんしゅ館の銘柄は時期ごとに入れ替わります。マスタの更新は2通り：

### 自動更新 (推奨)

**GitHub Actions が毎月1日 日本時間12時に自動実行** されます（`.github/workflows/update-master.yml`）。差分があればbotが自動コミットするので、通常は何もしなくてOK。

初回だけ、リポジトリの Settings → Actions → General → Workflow permissions を **Read and write permissions** に設定してください（自動コミットに必要）。

手動実行したい場合は Actions タブから "Update master" → "Run workflow"。

### 手動更新

ローカルで`build_master.py`を実行してコミット：

```bash
pip install -r scripts/requirements.txt
python scripts/build_master.py
git add data/master.json
git commit -m "Update master"
git push
```

### 差分更新のしくみ

スクリプトは既存の`master.json`を読み込み、スクレイピング結果との差分を適用します：

- **ID永続**: 銘柄IDは一度振られたら変わりません（`sake-0001`など）
- **新規銘柄**: 新しいIDを採番して追加、`first_seen`に今日の日付
- **引退した銘柄**: `available_at`の該当店舗エントリに`retired_at`を付与（削除はしない）
- **復活した銘柄**: `retired_at`を外す
- **番号変更**: `available_at`内の`number`を更新

つまり、過去に飲んだ銘柄がメニューから消えても、**記録はそのまま残ります**。アプリ上は「終了」バッジが付くだけ。

## データ形式

### `data/master.json`

```json
{
  "updated_at": "2026-04-18",
  "stores": [
    { "id": "niigata", "name": "新潟驛店" },
    { "id": "nagaoka", "name": "長岡驛店" },
    { "id": "yuzawa", "name": "越後湯沢驛店" }
  ],
  "sake": [
    {
      "id": "sake-0001",
      "brewery": "DHC酒造",
      "name": "嘉山",
      "image_url": "https://www.ponshukan.com/wp/...",
      "first_seen": "2026-04-18",
      "available_at": [
        { "store": "niigata", "number": "013" },
        { "store": "nagaoka", "number": "013" },
        { "store": "yuzawa",  "number": "013", "retired_at": "2026-06-01" }
      ]
    }
  ]
}
```

- `id`は一度振ったら永続。差分更新で変わりません
- `first_seen`は初めてマスタに登場した日
- `available_at[i].retired_at`があれば「その店舗では提供終了」。全店舗に`retired_at`があれば完全引退扱い

### `data/records.json`

```json
{
  "updated_at": "2026-04-17T14:30:00.000Z",
  "records": [
    {
      "id": "r_1713345000000_abc12",
      "sake_id": "sake-0001",
      "rating": 4,
      "memo": "フルーティで飲みやすい",
      "drunk_at": "2026-04-17T14:30:00.000Z",
      "store": "niigata"
    }
  ]
}
```

## セキュリティについて

- PATは端末のlocalStorageに保存されます。**他人が触れる端末では設定しないでください**。
- PATのスコープは**このリポジトリの Contents 権限のみ**に絞ることを強く推奨。万が一漏れても被害を限定できます。
- 記録 (`records.json`) はPublicリポジトリでは公開されます。見られたくない内容を書かないか、リポジトリをPrivateに切り替えてください（その場合 GitHub Pages は有料プランが必要）。

## 今後やりたいこと（後回し機能）

- 📸 写真添付
- 📊 詳細な統計画面（酒蔵別達成率、月別推移、お気に入りTOP）
- 🏷 自分で付けるタグ（辛口/甘口/フルーティなど）
- 🗺 酒蔵の地域マップ
- 🌡 温度帯別（冷/常温/燗）の評価
- 🎯 コイン枚数（1/3/5）の記録
- 🔍 QRコード読み取り（将来的に銘柄ラベルから）

## ライセンス

個人利用前提のため、特に指定しません。

銘柄データの著作権および商標は各酒蔵および株式会社ぽんしゅ館に帰属します。本アプリは個人の記録目的で公式サイトの公開情報を参照しています。
