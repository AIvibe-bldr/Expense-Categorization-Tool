# GALAPAGOS 支出管理

Next.js / TypeScript の独立した支出管理モジュールです。**売上取得・売上計算・既存利益からの自動減算は実装していません。**

## 起動

Node.js 24以上が必要です（ローカルDBは `node:sqlite`）。

```bash
npm ci --cache /workspace/.npm-cache
cp .env.example .env.local # 初回のみ。既存設定は上書きしない
npm run dev
```

開発サーバーはループバックのポート3000で起動します。`GALAPAGOS_LOCAL_MODE=1` は認証を省いた単独開発専用です。公開サーバーでは使用できず、本番モードでは明示的に拒否されます。

```bash
npm test
npm run typecheck
npm run build
npm run test:e2e # Chromium が必要。CHROMIUM_PATH で実行ファイル指定可
```

## 実装範囲

- 5サービスの独立CSVアダプター、列対応、UTF-8 / Shift_JIS、厳密な入力検証、原本行の暗号化保存。
- 円単位整数、重複取込防止、全行検証後の一括保存、同時更新の競合検出。
- 元Excelの298分類、年度・セル単位の固有ID、同名の区別、色、小計グループ、月別表。
- 利用先正規化、分類候補、ユーザー承認ルール、分類・項目の追加と編集、月別の未振分け一覧、利用先分類と用途分類の分離。
- カード引落・銀行振替・PayPayチャージ・PayPay/カード重複・利用取消の照合。
- ダッシュボード、明細検索、分類確認、照合、連携設定、監査履歴、暗号化バックアップ、補助Excel出力。
- Google OAuth、Sheets更新、取込・変更後の再集計、手動同期、日次ジョブ用エンドポイント。
- ローカルSQLite、Supabase Auth/RLS対応の本番ストレージとSQLマイグレーション。

## 検証の境界

実サービスの公式CSVサンプル・接続権限は未提供です。`public/samples/` はすべて**架空の検証データ**であり、各社の現在の公式CSV形式と一致するという主張ではありません。実CSVで列対応と金額を確認してください。金融APIの架空エンドポイントやパスワード保存・スクレイピングはありません。

Google実アカウント・Supabase実プロジェクトでの接続試験は未実施です。Sheets APIはモック試験、永続化と画面は実SQLite/Chromiumで検証します。既存売上コードは空のリポジトリに存在しなかったため、売上ツールの回帰試験は実行できません。

## ドキュメント

- [利用・運用マニュアル](docs/USER_MANUAL.md)
- [本番接続・セキュリティ・バックアップ](docs/DEPLOYMENT.md)
- [データ・分類・照合の設計と制約](docs/ARCHITECTURE.md)
- [金融連携の調査状況](docs/CONNECTIVITY.md)
- [検証記録](docs/VALIDATION.md)
- [元Excelの抽出記録](data/excel-provenance.json)

金融情報を含む元Excel・実CSV・秘密情報・ローカルDBをGitに追加しないでください。元Excelから抽出した分類名には利用先名が含まれるため、このリポジトリは非公開での運用を前提とします。
