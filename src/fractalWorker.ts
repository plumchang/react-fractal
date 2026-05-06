// このファイルは Web Worker のスクリプトとして実行される。
// 通常の TS ファイルと違い、`window` は無く、`self` が DedicatedWorkerGlobalScope。
// `lib: "webworker"` を参照することで、Worker 専用の型（onmessage, postMessage など）を有効化する。
/// <reference lib="webworker" />

// `self` の型を DedicatedWorkerGlobalScope として宣言。
// これで `self.onmessage = ...` や `self.postMessage(...)` が型安全に書ける。
declare const self: DedicatedWorkerGlobalScope;

/**
 * マンデルブロ集合の収束判定を行う関数。
 *
 * 漸化式 `z_{n+1} = z_n^2 + c` を z_0 = 0 から繰り返す。
 *  - 一定回数（maxIter）以内に |z| > 2 まで発散した → "発散"。発散までの回数を返す
 *  - maxIter 回繰り返しても発散しなかった → マンデルブロ集合の点とみなす。maxIter を返す
 *
 * 戻り値 `i` は描画時に色を決定するのに使う（i が小さい＝早く発散＝外周部）。
 */
function mandelbrot(c_re: number, c_im: number, maxIter: number): number {
  // ===== 高速化のための早期リターン =====
  // マンデルブロ集合のうち、計算しなくても「集合に含まれる」と分かる領域がある。
  // これらの領域を先にチェックしてループをスキップすることで、
  // 中央部の黒い領域での計算量を大幅に削減できる。

  // (1) メインカルディオイド（マンデルブロ集合の本体である「ハート型」の領域）の判定。
  //     この領域内の点は必ず集合に含まれることが数学的に証明されている。
  const q = Math.pow(c_re - 0.25, 2) + c_im * c_im;
  if (q * (q + (c_re - 0.25)) <= 0.25 * c_im * c_im) {
    return maxIter;
  }
  // (2) 周期2の球（メインカルディオイドの左にくっついている円形の領域）の判定。
  //     中心 (-1, 0)、半径 1/4 の円の中に入っているかをチェック。
  //     (c_re + 1)^2 + c_im^2 <= (1/4)^2 = 1/16 = 0.0625
  if (Math.pow(c_re + 1.0, 2) + c_im * c_im <= 0.0625) {
    return maxIter;
  }

  // ===== 通常の漸化式ループ =====
  // z は複素数なので実部 z_re と虚部 z_im で表現する。
  // z^2 = (z_re + i*z_im)^2 = (z_re^2 - z_im^2) + i*(2*z_re*z_im)
  // よって  new z_re = z_re^2 - z_im^2 + c_re
  //         new z_im = 2*z_re*z_im + c_im
  let z_re = 0;
  let z_im = 0;
  let i = 0;

  // 発散判定の閾値。|z|^2 > 4（つまり |z| > 2）になったら発散確定。
  // 数学的に「マンデルブロ集合に含まれる点では |z| <= 2 が常に成り立つ」ことが知られている。
  const bailout = 4.0;
  // 念のため上限を設けているが、現状の呼び出し側は maxIter=100 固定なので実質効いていない。
  const maxIterations = Math.min(maxIter, 1000);

  while (i < maxIterations) {
    // 二乗値を一度だけ計算して使い回す（最適化）
    const z_re2 = z_re * z_re;
    const z_im2 = z_im * z_im;
    // |z|^2 = z_re^2 + z_im^2 が bailout を超えたら発散
    if (z_re2 + z_im2 > bailout) break;

    // 漸化式を進める。順序に注意：z_re を更新する前に z_im を計算する必要がある
    // （z_im の式で「更新前の z_re」を使うため）
    z_im = 2 * z_re * z_im + c_im;
    z_re = z_re2 - z_im2 + c_re;
    i++;
  }
  return i;
}

/**
 * メイン側からのリクエストを受信して、担当チャンクを計算するハンドラ。
 *
 * メッセージは以下の形で届く（App.tsx 側で postMessage している）:
 *  {
 *    width:    キャンバス全体の幅(px)
 *    startY:   このワーカーが担当する開始行
 *    endY:     終了行（exclusive）
 *    zoom:     拡大率（1px あたりの複素平面上の長さの逆数）
 *    offsetX:  描画範囲の左上の複素平面上の x 座標（実部）
 *    offsetY:  描画範囲の左上の複素平面上の y 座標（虚部）
 *    maxIter:  発散判定の最大反復回数
 *  }
 */
self.onmessage = (event: MessageEvent) => {
  const { width, startY, endY, zoom, offsetX, offsetY, maxIter } = event.data;
  const chunkHeight = endY - startY;

  // RGBA 4 バイト × ピクセル数。Uint8ClampedArray は Canvas の ImageData が要求する型。
  // 後で transferable で渡すため、明示的な ArrayBuffer ベースの型を使う。
  const imageData = new Uint8ClampedArray(width * chunkHeight * 4);

  for (let y = startY; y < endY; y++) {
    for (let x = 0; x < width; x++) {
      // ピクセル座標 (x, y) → 複素平面座標 (c_re, c_im) への変換
      // zoom が大きいほど 1px あたりの実距離が小さくなる（＝拡大される）
      const c_re = x / zoom + offsetX;
      const c_im = y / zoom + offsetY;

      // マンデルブロ集合の判定
      const iter = mandelbrot(c_re, c_im, maxIter);

      // チャンク内の相対 y 座標を使って配列のインデックスを計算
      // 1 ピクセル = 4 バイト（R, G, B, A）
      const idx = ((y - startY) * width + x) * 4;

      if (iter < maxIter) {
        // 発散した点：発散までの反復回数を色のグラデーションに変換
        // 簡易的な色付け（係数 2,5,3 は見た目で調整したマジックナンバー）
        imageData[idx] = iter * 2;     // R
        imageData[idx + 1] = iter * 5; // G
        imageData[idx + 2] = iter * 3; // B
        imageData[idx + 3] = 255;      // A（不透明）
      } else {
        // 発散しなかった＝マンデルブロ集合の点：黒で塗る
        imageData[idx] = 0;
        imageData[idx + 1] = 0;
        imageData[idx + 2] = 0;
        imageData[idx + 3] = 255;
      }
    }
  }

  // メインスレッドへ計算結果を返す。
  // 第2引数の transferable リストに ArrayBuffer を入れると、コピーではなく所有権の移譲になる。
  // 結果として Worker 側からは imageData は使えなくなるが、メイン側では zero-copy で受け取れる
  // → 大きなバッファを高速に渡せる。
  self.postMessage({ startY, chunkData: imageData.buffer }, [imageData.buffer]);
};
