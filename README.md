# react-fractal

React + TypeScript + Vite で実装したマンデルブロ集合のリアルタイム描画アプリです。Web Worker × 4 で並列計算しています。

姉妹プロジェクト [`yew-fractal`](../yew-fractal) と性能比較するためのサンプルとして作成しました。両アプリの実装と比較考察は以下の Zenn 記事にまとめています。

- 記事: 「Rust(Yew) vs JavaScript(React) — マンデルブロ集合で実測した WebAssembly のリアルな速度差」（公開時に URL を追記）
- デプロイ済みデモ: https://plumchang.github.io/react-fractal/

## 使い方

### 必要なもの

- Node.js 18+ / npm

### 開発サーバ起動

```bash
npm install
npm run dev
```

ブラウザが自動で開きます（デフォルト http://localhost:5173/）。

### 本番ビルド

```bash
npm run build
```

`dist/` 以下に成果物が出力されます。

### 操作方法

| 操作 | 動作 |
|---|---|
| マウスホイール | カーソル位置を中心にズームイン／アウト |
| ドラッグ | 描画領域のパン（移動） |
| 二本指タッチ（モバイル） | ピンチでズーム |
| 一本指ドラッグ（モバイル） | パン |

画面左上には現在の中心座標、ズーム倍率、フレーム計算時間（ms）、FPS を表示しています。

## アーキテクチャ概要

```
[UI スレッド]
   ↓ postMessage(width, startY, endY, zoom, ox, oy, maxIter)
[Worker × 4] 各スレッドで担当チャンクを並列計算
   ↑ postMessage(startY, chunkData: ArrayBuffer)
[UI スレッド] 4 チャンクが揃ったら ImageData を合成して putImageData
```

実装の特徴：

- **Worker は使い回し**：起動時に 4 つ作ったプールを再利用（毎フレーム生成しない）
- **連続描画は間引く**：描画中の追加リクエストは「最新の 1 件だけ」を queued に保留し、現フレーム完了後に発行
- **transferable で受け渡し**：`postMessage` の第 2 引数に ArrayBuffer を渡してゼロコピー転送

## ファイル構成

```
src/
├── App.tsx              … UI コンポーネント + FractalPool クラス
├── fractalWorker.ts     … Worker エントリ。マンデルブロ計算本体
└── main.tsx             … React エントリポイント
```

### `fractalWorker.ts`

マンデルブロ集合の収束判定 (`mandelbrot` 関数) と、メインスレッドからのリクエストを処理する `self.onmessage` ハンドラを実装。

性能のためにいくつか早期リターンを入れています：

- メインカルディオイド判定（マンデルブロ集合の中央のハート型領域）
- 周期 2 の球判定（中心 (-1, 0)、半径 1/4 の円）

これらの領域は数学的に「絶対に発散しない」ことが分かっているので、ループを回さずに `maxIter` を即返します。中央の黒い領域でのフレーム時間を大幅に削減できます。

### `App.tsx` / `FractalPool`

`FractalPool` クラスは 4 つの Worker を束ねるプールで、React の外（プレーンクラス）に持ち出しています。

なぜ React の外に置くか：
- Worker や ArrayBuffer は「再レンダーで作り直されては困る」リソース
- `useState`/`useEffect` で管理すると依存関係が複雑化し、Worker が意図せず再生成される事故が起きやすい
- クラスに切り出すことでライフサイクルを明示的に制御できる

主要メソッド：

- `submit(params)`: 描画リクエスト。`inFlight` 中なら `queued` に最新値を上書き
- `onMessage(data)`: Worker からの応答。`startY` で書き込み位置を特定して全画面バッファに合成。4 件揃ったら `putImageData`
- `terminate()`: アンマウント時に Worker を破棄

`paramsRef` パターン：

```ts
const paramsRef = useRef<DrawParams>({ zoom, offsetX, offsetY });
paramsRef.current = { zoom, offsetX, offsetY };

const drawFractal = useCallback(() => {
  poolRef.current?.submit(paramsRef.current);
}, []);
```

`useCallback` の依存に `zoom` 等を入れると、状態が変わるたびに `drawFractal` の関数 instance が変わって `useEffect` の依存連鎖が壊れます。`paramsRef` に「最新値のコピー」を毎レンダー保持しておけば、`drawFractal` は依存ゼロのまま最新値を読めます。

## 開発時の注意点（落とし穴）

### Vite の Worker 静的解析

Worker を `new Worker(new URL(...))` で起動するとき、**「直書き」する必要があります**。変数を介すと Vite がパターンを検出できず、本番ビルドで Worker のソースが正しくバンドルされません。

```ts
// ❌ 変数経由は NG
const url = new URL("./fractalWorker.ts", import.meta.url);
const worker = new Worker(url);

// ✅ 直書き
const worker = new Worker(
  new URL("./fractalWorker.ts", import.meta.url),
  { type: "module" }
);
```

直書きしないと、本番デプロイ時に `.ts` ファイルが直接配信され、GitHub Pages では `video/mp2t`（MPEG Transport Stream）として返ってきます。ブラウザは MIME type 不一致でロードを拒否し、画面が真っ白になります。

`npm run dev` では Vite の on-the-fly トランスパイルにより問題が表面化しないため、**dev で動く ≠ prod で動く** の典型例として注意が必要です。

### `vite.config.ts`

GitHub Pages のサブパス配信用に `base: "/react-fractal/"` を設定しています。フォークして別リポジトリにデプロイする場合は変更してください。

## 計測指標

画面左上のオーバーレイに以下を表示しています：

- **Frame**: 描画リクエスト発行から `putImageData` 完了までの時間 [ms]
- **FPS**: 直近 1 秒間に完了したフレーム数

純粋な計算性能を測るのは Frame ms です。FPS は「ホイールをどれだけ回したか」など操作頻度に依存するので参考値です。

## 関連リンク

- 姉妹プロジェクト: [`yew-fractal`](../yew-fractal)（Rust + Yew + WebAssembly 版）
- マンデルブロ集合: [Wikipedia](https://ja.wikipedia.org/wiki/マンデルブロ集合)
- Vite の Worker サポート: [Vite 公式 - Web Workers](https://vite.dev/guide/features#web-workers)
