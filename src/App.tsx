import React, {
  useRef,
  useState,
  useEffect,
  useCallback,
  MouseEvent,
  TouchEvent,
} from "react";

// 4 並列で計算する。CPU コア数より多くしても通常は速くならない。
const NUM_WORKERS = 4;
// マンデルブロの最大反復回数。値を上げると境界の詳細が見えるが計算量が増える。
const MAX_ITER = 100;

// Worker → Main へ送るメッセージの型
interface WorkerResponse {
  startY: number; // この chunk の開始行（合成時のオフセット計算に使う）
  chunkData: ArrayBuffer; // RGBA の生バッファ（transferable で受け渡し）
}

// 1 フレームの描画パラメータ
interface DrawParams {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Worker 4 つを使い回し、in_flight 中の追加リクエストは
 * 「最後の 1 つだけ」を queued に保留して描画完了後に流す。
 * Yew 版と同じアーキテクチャに揃え、純粋に言語/ランタイム差を比較できるようにする。
 *
 * なぜ React の外（クラス）に持ち出しているか:
 *  - Worker や ArrayBuffer は「React の再レンダーで作り直されては困る」リソース
 *  - useState/useEffect で扱うと依存関係が複雑になり、意図せず Worker が再生成される
 *  - クラスに切り出すことで、ライフサイクルを明示的に制御できる
 */
class FractalPool {
  private workers: Worker[] = [];
  // 現在描画中のキャンバスサイズ。Worker から chunk が返ってくる時に使う
  private width = 0;
  private height = 0;
  // 4 つの chunk を集約する全画面分のバッファ（毎フレーム使い回す）
  private imgBuf: Uint8ClampedArray = new Uint8ClampedArray();
  // 受信した chunk 数のカウント。NUM_WORKERS に達したら 1 フレーム完成
  private received = 0;
  // 描画中フラグ。true の間は新規リクエストを queued に保留する
  private inFlight = false;
  // 描画中に来た最新リクエスト（古いものは捨てて最後の 1 つだけ保持）
  private queued: DrawParams | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  // 計測用：フレーム開始時刻と完了時刻の履歴（直近 1 秒以内のもので FPS 算出）
  private frameStart = 0;
  private frameHistory: number[] = [];
  // メトリクスを React 側に通知するためのコールバック
  private onMetrics: ((m: { frameMs: number; fps: number }) => void) | null =
    null;

  constructor() {
    // Worker を NUM_WORKERS 個一括で起動。これらは破棄されるまで使い回す。
    // 重要: new Worker(new URL(...)) を「直書き」する必要がある。
    // 変数経由だと Vite の静的解析が効かず、Worker のソースが bundle されない（落とし穴③参照）
    for (let i = 0; i < NUM_WORKERS; i++) {
      const worker = new Worker(
        new URL("./fractalWorker.ts", import.meta.url),
        { type: "module" },
      );
      // 各 Worker からのメッセージは onMessage に集約する。
      // どの Worker から来たかは、メッセージ内の startY で識別する
      worker.onmessage = (e: MessageEvent<WorkerResponse>) =>
        this.onMessage(e.data);
      this.workers.push(worker);
    }
  }

  setCanvas(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
  }

  setMetricsListener(fn: (m: { frameMs: number; fps: number }) => void) {
    this.onMetrics = fn;
  }

  /**
   * 描画リクエストを発行する。
   *
   * 連続して呼ばれた場合の戦略:
   *   - 描画中なら → 最新パラメータを queued に上書き（古い保留は捨てる）
   *   - 描画完了後に queued があれば、それで再 submit
   * これにより「ホイールを連打しても、計算リソースを無駄に使わない」かつ
   *「常に最新位置の絵が最終的に表示される」を両立する。
   */
  submit(params: DrawParams) {
    if (this.inFlight) {
      this.queued = params;
      return;
    }
    if (!this.canvas) return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (width === 0 || height === 0) return;

    // フレームの状態を初期化
    this.width = width;
    this.height = height;
    // 全画面分の RGBA バッファ。Worker からの chunk をここに合成する
    this.imgBuf = new Uint8ClampedArray(width * height * 4);
    this.received = 0;
    this.inFlight = true;
    this.frameStart = performance.now();

    // 画面を縦方向に 4 等分して、各 Worker に担当領域を割り当てる
    // 例: height=720 なら chunk0: 0-179, chunk1: 180-359, chunk2: 360-539, chunk3: 540-719
    const chunkSize = Math.floor(height / NUM_WORKERS);
    for (let i = 0; i < NUM_WORKERS; i++) {
      const startY = i * chunkSize;
      // 最後の Worker は端数を含めて height まで担当
      const endY = i === NUM_WORKERS - 1 ? height : (i + 1) * chunkSize;
      this.workers[i].postMessage({
        width,
        startY,
        endY,
        zoom: params.zoom,
        offsetX: params.offsetX,
        offsetY: params.offsetY,
        maxIter: MAX_ITER,
      });
    }
  }

  /**
   * 各 Worker からの応答ハンドラ。
   * 全 Worker (NUM_WORKERS) からの応答が揃った時点で 1 フレームが完成する。
   */
  private onMessage(data: WorkerResponse) {
    // transferable で渡された ArrayBuffer から Uint8ClampedArray の view を作る（ゼロコピー）
    const chunkArray = new Uint8ClampedArray(data.chunkData);

    // chunk を全画面バッファの該当オフセットに書き込む
    // startY を使うことで「どの Worker からの応答か」を特定でき、順不同でも正しく合成できる
    const offset = data.startY * this.width * 4;
    if (offset + chunkArray.length <= this.imgBuf.length) {
      this.imgBuf.set(chunkArray, offset);
    }
    this.received++;

    // 4 つ全部揃った → 1 フレーム完成
    if (this.received === NUM_WORKERS) {
      this.inFlight = false;
      this.received = 0;

      // バッファを Canvas に転送して画面を更新
      if (this.ctx) {
        const imgData = new ImageData(this.imgBuf, this.width, this.height);
        this.ctx.putImageData(imgData, 0, 0);
      }

      // 計測値の更新（直近 1 秒以内に完了したフレーム数 = FPS）
      const end = performance.now();
      const frameMs = end - this.frameStart;
      this.frameHistory.push(end);
      const cutoff = end - 1000;
      while (this.frameHistory.length > 0 && this.frameHistory[0] < cutoff) {
        this.frameHistory.shift();
      }
      this.onMetrics?.({ frameMs, fps: this.frameHistory.length });

      // 描画中に保留されたリクエストがあれば、ここで再開する
      if (this.queued) {
        const next = this.queued;
        this.queued = null;
        this.submit(next);
      }
    }
  }

  terminate() {
    this.workers.forEach((w) => w.terminate());
    this.workers = [];
  }
}

const App: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState<number>(200.0);
  const [offsetX, setOffsetX] = useState<number>(-2.0);
  const [offsetY, setOffsetY] = useState<number>(-1.0);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [lastMousePos, setLastMousePos] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [lastTouchDistance, setLastTouchDistance] = useState<number>(0);
  const poolRef = useRef<FractalPool | null>(null);
  const [metrics, setMetrics] = useState<{ frameMs: number; fps: number }>({
    frameMs: 0,
    fps: 0,
  });

  // 最新パラメータを ref で参照可能にする。
  // なぜ ref が必要か:
  //   useCallback の依存に zoom/offsetX/offsetY を入れると、これらが変わるたびに
  //   drawFractal の関数 instance が変わり、useEffect の依存連鎖が壊れる。
  //   ref に「最新値のコピー」を毎レンダー保持しておけば、drawFractal は
  //   依存ゼロのまま「呼ばれた瞬間の最新値」を読み取れる。
  const paramsRef = useRef<DrawParams>({ zoom, offsetX, offsetY });
  paramsRef.current = { zoom, offsetX, offsetY };

  // 描画リクエストを Pool に投げるだけのシンプルな関数
  const drawFractal = useCallback(() => {
    poolRef.current?.submit(paramsRef.current);
  }, []);

  // Pool は React のコンポーネントツリーとライフサイクルを共有する。
  //   - 初回マウントで Pool を生成し、Worker × 4 を起動
  //   - アンマウントで terminate して Worker を破棄
  // 依存配列を空にすることで、再レンダーで Pool が作り直されないようにする
  useEffect(() => {
    const pool = new FractalPool();
    pool.setMetricsListener(setMetrics);
    poolRef.current = pool;

    const canvas = canvasRef.current;
    if (canvas) {
      // Canvas のサイズをウィンドウに合わせる
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      pool.setCanvas(canvas);
    }
    // 初回描画
    pool.submit(paramsRef.current);

    return () => {
      pool.terminate();
      poolRef.current = null;
    };
  }, []);

  const onMouseDown = (e: MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    setIsDragging(true);
    setLastMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    e.preventDefault();
  };

  const onMouseMove = (e: MouseEvent<HTMLCanvasElement>) => {
    if (!isDragging) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const dx = x - lastMousePos.x;
    const dy = y - lastMousePos.y;
    setOffsetX((prev) => prev - dx / zoom);
    setOffsetY((prev) => prev - dy / zoom);
    setLastMousePos({ x, y });
    drawFractal();
  };

  const onMouseUp = () => {
    setIsDragging(false);
  };

  const onTouchStart = (e: TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();

    if (e.touches.length === 1) {
      const touch = e.touches[0];
      setIsDragging(true);
      setLastMousePos({
        x: touch.clientX - rect.left,
        y: touch.clientY - rect.top,
      });
    } else if (e.touches.length === 2) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const distance = Math.hypot(
        touch2.clientX - touch1.clientX,
        touch2.clientY - touch1.clientY,
      );
      setLastTouchDistance(distance);
    }
  };

  const onTouchMove = (e: TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();

    if (e.touches.length === 1 && isDragging) {
      const touch = e.touches[0];
      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;
      const dx = x - lastMousePos.x;
      const dy = y - lastMousePos.y;
      setOffsetX((prev) => prev - dx / zoom);
      setOffsetY((prev) => prev - dy / zoom);
      setLastMousePos({ x, y });
      drawFractal();
    } else if (e.touches.length === 2) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const distance = Math.hypot(
        touch2.clientX - touch1.clientX,
        touch2.clientY - touch1.clientY,
      );
      const centerX = (touch1.clientX + touch2.clientX) / 2 - rect.left;
      const centerY = (touch1.clientY + touch2.clientY) / 2 - rect.top;

      if (lastTouchDistance > 0) {
        const zoomFactor = distance / lastTouchDistance;
        const newZoom = zoom * zoomFactor;
        const dx = centerX / zoom - centerX / newZoom;
        const dy = centerY / zoom - centerY / newZoom;
        setOffsetX((prev) => prev + dx);
        setOffsetY((prev) => prev + dy);
        setZoom(newZoom);
        drawFractal();
      }
      setLastTouchDistance(distance);
    }
  };

  const onTouchEnd = () => {
    setIsDragging(false);
    setLastTouchDistance(0);
  };

  useEffect(() => {
    const handleWheel = (e: globalThis.WheelEvent) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mouseX = (e.clientX - rect.left) | 0;
      const mouseY = (e.clientY - rect.top) | 0;
      const zoomFactor = Math.pow(0.999, e.deltaY);
      const newZoom = zoom * zoomFactor;
      const dx = mouseX / zoom - mouseX / newZoom;
      const dy = mouseY / zoom - mouseY / newZoom;
      setOffsetX((prev) => prev + dx);
      setOffsetY((prev) => prev + dy);
      setZoom(newZoom);
      drawFractal();
    };

    const canvas = canvasRef.current;
    if (canvas) {
      canvas.addEventListener("wheel", handleWheel, { passive: false });
      return () => canvas.removeEventListener("wheel", handleWheel);
    }
  }, [zoom, drawFractal]);

  useEffect(() => {
    const handleResize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      drawFractal();
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [drawFractal]);

  return (
    <div style={{ overflow: "hidden", margin: 0, padding: 0 }}>
      <div
        style={{
          position: "absolute",
          top: 10,
          left: 10,
          background: "rgba(255,255,255,0.7)",
          padding: "5px",
          zIndex: 1,
        }}
      >
        <div>{`X: ${offsetX.toFixed(3)}`}</div>
        <div>{`Y: ${offsetY.toFixed(3)}`}</div>
        <div>{`Zoom: ${(zoom / 200).toFixed(1)}x`}</div>
        <div>{`Frame: ${metrics.frameMs.toFixed(1)} ms`}</div>
        <div>{`FPS: ${metrics.fps}`}</div>
      </div>
      <canvas
        ref={canvasRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{
          display: "block",
          width: "100vw",
          height: "100vh",
          border: "none",
          touchAction: "none",
        }}
      />
    </div>
  );
};

export default App;
