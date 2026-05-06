import React, {
  useRef,
  useState,
  useEffect,
  useCallback,
  MouseEvent,
  TouchEvent,
} from "react";

const NUM_WORKERS = 4;
const MAX_ITER = 100;

interface WorkerResponse {
  startY: number;
  chunkData: ArrayBuffer;
}

interface DrawParams {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Worker 4 つを使い回し、in_flight 中の追加リクエストは
 * 「最後の 1 つだけ」を queued に保留して描画完了後に流す。
 * Yew 版と同じアーキテクチャに揃え、純粋に言語/ランタイム差を比較できるようにする。
 */
class FractalPool {
  private workers: Worker[] = [];
  private width = 0;
  private height = 0;
  private imgBuf: Uint8ClampedArray = new Uint8ClampedArray();
  private received = 0;
  private inFlight = false;
  private queued: DrawParams | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private frameStart = 0;
  private frameHistory: number[] = [];
  private onMetrics: ((m: { frameMs: number; fps: number }) => void) | null =
    null;

  constructor() {
    for (let i = 0; i < NUM_WORKERS; i++) {
      const worker = new Worker(
        new URL("./fractalWorker.ts", import.meta.url),
        { type: "module" }
      );
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

  submit(params: DrawParams) {
    if (this.inFlight) {
      this.queued = params;
      return;
    }
    if (!this.canvas) return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (width === 0 || height === 0) return;

    this.width = width;
    this.height = height;
    this.imgBuf = new Uint8ClampedArray(width * height * 4);
    this.received = 0;
    this.inFlight = true;
    this.frameStart = performance.now();

    const chunkSize = Math.floor(height / NUM_WORKERS);
    for (let i = 0; i < NUM_WORKERS; i++) {
      const startY = i * chunkSize;
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

  private onMessage(data: WorkerResponse) {
    const chunkArray = new Uint8ClampedArray(data.chunkData);
    const offset = data.startY * this.width * 4;
    if (offset + chunkArray.length <= this.imgBuf.length) {
      this.imgBuf.set(chunkArray, offset);
    }
    this.received++;

    if (this.received === NUM_WORKERS) {
      this.inFlight = false;
      this.received = 0;
      if (this.ctx) {
        const imgData = new ImageData(this.imgBuf, this.width, this.height);
        this.ctx.putImageData(imgData, 0, 0);
      }

      const end = performance.now();
      const frameMs = end - this.frameStart;
      this.frameHistory.push(end);
      const cutoff = end - 1000;
      while (
        this.frameHistory.length > 0 &&
        this.frameHistory[0] < cutoff
      ) {
        this.frameHistory.shift();
      }
      this.onMetrics?.({ frameMs, fps: this.frameHistory.length });

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

  // 最新パラメータを ref で参照可能にして、毎回 submit に渡す
  const paramsRef = useRef<DrawParams>({ zoom, offsetX, offsetY });
  paramsRef.current = { zoom, offsetX, offsetY };

  const drawFractal = useCallback(() => {
    poolRef.current?.submit(paramsRef.current);
  }, []);

  // 初回マウントで Pool を生成、アンマウントで terminate
  useEffect(() => {
    const pool = new FractalPool();
    pool.setMetricsListener(setMetrics);
    poolRef.current = pool;

    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      pool.setCanvas(canvas);
    }
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
        touch2.clientY - touch1.clientY
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
        touch2.clientY - touch1.clientY
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
