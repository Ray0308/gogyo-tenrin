# 五行転輪

『五行転輪』MVPのクライアント・サーバー共通リポジトリです。

## 仕様書

実装前に、唯一の正である [docs/specification.md](docs/specification.md) を確認してください。

## 必要環境

- Node.js 20以上
- npm

## ローカル起動

```bash
npm install
npm run build
npm start
```

起動後、以下へアクセスします。

- ゲーム画面: <http://localhost:3000/>
- ヘルスチェック: <http://localhost:3000/health>

環境変数 `PORT` が未指定の場合はポート3000を使用します。

現在は、タイトル画面からCPU戦を選び、プレイヤー名入力、初期属性選択、属性公開、初期対戦画面まで操作できます。

## Render

- Build Command: `npm install && npm run build`
- Start Command: `npm start`
- Health Check Path: `/health`
## マスターデータ

編集元データは `master/data/`、ゲームが読み込む生成済みデータは `server/data/` に配置します。カードの `effectText` は表示用文章であり、ゲーム処理では解析しません。構造化された `effects` を使用します。

```bash
npm run data:build
npm run data:validate
npm test
```

`npm run build` はデータ生成と検証も自動実行します。不正なID、重複ID、参照切れ、必須値不足、バージョン不一致がある場合はビルドまたはサーバー起動を失敗させます。

Googleスプレッドシートから書き出したExcelを同期する場合:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/import-master.ps1 -WorkbookPath <xlsxファイル>
```

インポート後は `master/data/` から `server/data/` が自動生成されます。データ形式は `server/data/schemas/`、バージョンとファイル件数は `server/data/manifest.json` で管理します。
## MVP status

- CPU and online matches use the same authoritative server game engine.
- Online rooms support create, join, host start, private hands, reconnect waiting, turn timers, reactions, and rematch requests.
- All 90 master cards have structured effects and are validated before the server starts.
- Run `npm test` to build, validate master data, and execute the online integration flow.
