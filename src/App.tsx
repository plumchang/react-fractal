import React, {
  useRef,
  useState,
  useEffect,
  useCallback,
  MouseEvent,
  TouchEvent,
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
  const [lastTouchDistance, setLastTouchDistance] = useState<number>(0);
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

  // タッチ開始時の処理
  const onTouchStart = (e: TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();

    if (e.touches.length === 1) {
      // 単一タッチの場合はドラッグ開始
      const touch = e.touches[0];
      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;
      setIsDragging(true);
      setLastMousePos({ x, y });
    } else if (e.touches.length === 2) {
      // 2本指タッチの場合はピンチズーム開始
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const distance = Math.hypot(
        touch2.clientX - touch1.clientX,
        touch2.clientY - touch1.clientY
      );
      setLastTouchDistance(distance);
    }
  };

  // タッチ移動時の処理
  const onTouchMove = (e: TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();

    if (e.touches.length === 1 && isDragging) {
      // 単一タッチの場合はパン
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
      // 2本指タッチの場合はピンチズーム
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const distance = Math.hypot(
        touch2.clientX - touch1.clientX,
        touch2.clientY - touch1.clientY
      );

      // ピンチズームの中心点を計算
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

  // タッチ終了時の処理
  const onTouchEnd = () => {
    setIsDragging(false);
    setLastTouchDistance(0);
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

  // ウィンドウサイズ変更時にcanvasサイズを更新
  useEffect(() => {
    const handleResize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      drawFractal();
    };

    // 初期サイズ設定
    handleResize();

    // リサイズイベントの購読
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

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
