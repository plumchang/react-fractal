/// <reference lib="webworker" />

self.onmessage = (event) => {
  const { width, startY, endY, zoom, offsetX, offsetY, maxIter } = event.data;
  const chunkHeight = endY - startY;
  const imageData = new Uint8ClampedArray(width * chunkHeight * 4);

  for (let y = startY; y < endY; y++) {
    for (let x = 0; x < width; x++) {
      const c_re = x / zoom + offsetX;
      const c_im = y / zoom + offsetY;
      const iter = mandelbrot(c_re, c_im, maxIter);
      const idx = ((y - startY) * width + x) * 4;
      if (iter < maxIter) {
        imageData[idx] = iter * 2;
        imageData[idx + 1] = iter * 5;
        imageData[idx + 2] = iter * 3;
        imageData[idx + 3] = 255;
      } else {
        imageData[idx] = 0;
        imageData[idx + 1] = 0;
        imageData[idx + 2] = 0;
        imageData[idx + 3] = 255;
      }
    }
  }
  self.postMessage({ startY, chunkData: imageData.buffer }, [imageData.buffer]);
};

// マンデルブロ集合の収束判定関数
function mandelbrot(c_re: number, c_im: number, maxIter: number) {
  // カルディオイド判定による早期リターン
  const q = Math.pow(c_re - 0.25, 2) + c_im * c_im;
  if (q * (q + (c_re - 0.25)) <= 0.25 * c_im * c_im) {
    return maxIter;
  }
  // 周期2の球判定
  if (Math.pow(c_re + 1.0, 2) + c_im * c_im <= 0.0625) {
    return maxIter;
  }

  let z_re = 0;
  let z_im = 0;
  let i = 0;

  // 計算量を制限
  const bailout = 4.0;
  const maxIterations = Math.min(maxIter, 1000); // 最大反復回数を制限

  while (i < maxIterations) {
    const z_re2 = z_re * z_re;
    const z_im2 = z_im * z_im;
    if (z_re2 + z_im2 > bailout) break;

    z_im = 2 * z_re * z_im + c_im;
    z_re = z_re2 - z_im2 + c_re;
    i++;
  }
  return i;
}
