import React, {
  useRef,
  useState,
  useEffect,
  useCallback,
  MouseEvent,
} from "react";

const FractalWorker = new URL("./fractalWorker.js", import.meta.url);

interface WorkerMessage {
  startY: number;
  chunkData: ArrayBuffer;
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
  const workers = useRef<Worker[]>([]);

  // フラクタル描画処理（Web Worker 4 つによる並列計算）
  const drawFractal = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 既存のWorkerをクリーンアップ
    workers.current?.forEach((worker) => worker.terminate());

    const width = canvas.width;
    const height = canvas.height;
    const maxIter = 100;
    const numWorkers = 4;
    const chunkSize = Math.floor(height / numWorkers);
    const imageData = new Uint8ClampedArray(width * height * 4);
    let workersCompleted = 0;

    // 各 worker からのメッセージ受け取りハンドラ
    const handleWorkerMessage = (e: MessageEvent<WorkerMessage>) => {
      const { startY, chunkData } = e.data;
      const chunkArray = new Uint8ClampedArray(chunkData);
      // 該当チャンクのデータを全体の imageData にコピー
      imageData.set(chunkArray, startY * width * 4);
      workersCompleted++;
      if (workersCompleted === numWorkers) {
        const imgData = new ImageData(imageData, width, height);
        ctx.putImageData(imgData, 0, 0);
      }
    };

    // 各チャンク毎に worker を作成して計算を依頼
    for (let i = 0; i < numWorkers; i++) {
      const worker = new Worker(FractalWorker);
      const startY = i * chunkSize;
      const endY = i === numWorkers - 1 ? height : (i + 1) * chunkSize;
      worker.onmessage = handleWorkerMessage;
      worker.postMessage({
        width,
        startY,
        endY,
        zoom,
        offsetX,
        offsetY,
        maxIter,
      });
      workers.current.push(worker);
    }
  }, [zoom, offsetX, offsetY]);

  // マウスダウン時：ドラッグ開始
  const onMouseDown = (e: MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setIsDragging(true);
    setLastMousePos({ x, y });
    e.preventDefault();
  };

  // マウス移動時：ドラッグによるパン
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

  // マウスアップ時：ドラッグ終了
  const onMouseUp = () => {
    setIsDragging(false);
  };

  // 初回レンダリング時および依存値変更時に描画
  useEffect(() => {
    drawFractal();
  }, [drawFractal]);

  useEffect(() => {
    const handleWheel = (e: globalThis.WheelEvent) => {
      e.preventDefault();

      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();

      // より正確な座標計算
      const mouseX = (e.clientX - rect.left) | 0; // 整数化
      const mouseY = (e.clientY - rect.top) | 0; // 整数化

      // より滑らかなズーム係数
      const zoomFactor = Math.pow(0.999, e.deltaY);
      const newZoom = zoom * zoomFactor;

      // 座標計算の精度を改善
      const dx = mouseX / zoom - mouseX / newZoom;
      const dy = mouseY / zoom - mouseY / newZoom;

      // 状態更新をバッチ化
      requestAnimationFrame(() => {
        setOffsetX((prev) => prev + dx);
        setOffsetY((prev) => prev + dy);
        setZoom(newZoom);
        drawFractal(); // debounceを削除し、直接描画
      });
    };

    const canvas = canvasRef.current;
    if (canvas) {
      canvas.addEventListener("wheel", handleWheel, { passive: false });
      return () => canvas.removeEventListener("wheel", handleWheel);
    }
  }, [zoom, drawFractal]);

  return (
    <div>
      <div
        style={{
          position: "absolute",
          top: 10,
          left: 10,
          background: "rgba(255,255,255,0.7)",
          padding: "5px",
        }}
      >
        <div>{`X: ${offsetX.toFixed(3)}`}</div>
        <div>{`Y: ${offsetY.toFixed(3)}`}</div>
        <div>{`Zoom: ${(zoom / 200).toFixed(1)}x`}</div>
      </div>
      <canvas
        ref={canvasRef}
        width={800}
        height={600}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        style={{ border: "1px solid black" }}
      />
    </div>
  );
};

export default App;
