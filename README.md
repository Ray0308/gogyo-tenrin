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