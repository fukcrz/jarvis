import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { RotateCcw, RotateCw, X, ZoomIn, ZoomOut } from "lucide-react";
import { useHistoryBackTrap } from "../lib/history-back-trap";

/** 缩放上下限与每档倍率（对齐 compass 预览组件的 0.1x–5x、×1.2）。 */
const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
const ZOOM_STEP = 1.2;
/** 指针移动超过该像素距离后，抬手不再算作「点空白关闭」，避免拖拽平移时误关。 */
const TAP_SLOP = 6;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** 滚轮/按钮缩放：按固定倍率放大或缩小，并夹在上下限内。 */
export function nextScale(scale: number, direction: 1 | -1): number {
  return clampScale(direction === 1 ? scale * ZOOM_STEP : scale / ZOOM_STEP);
}

/** 旋转按 90° 步进并归一化到 [0, 360)，避免一次会话里角度无限累加。 */
export function nextAngle(angle: number, direction: 1 | -1): number {
  return (((angle + direction * 90) % 360) + 360) % 360;
}

interface DragState {
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  /** 按下点在大图上时点空白不关闭；用标记记录，避免指针捕获改写 event.target。 */
  fromBackdrop: boolean;
  moved: boolean;
}

interface ImageLightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

/**
 * 图片预览浮层：缩放（滚轮 + 控件 + 双指）、拖拽平移、±90° 旋转，
 * 点空白或 Esc 关闭。挂到 body 上，避免被消息 DOM 或滚动容器裁剪。
 */
export function ImageLightbox({ src, alt = "", onClose }: ImageLightboxProps) {
  useHistoryBackTrap(true, onClose);
  const [scale, setScale] = useState(1);
  const [angle, setAngle] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<DragState | undefined>(undefined);
  /** 抬手时判定为「点空白」的点击，等 click 事件到达时再关闭（见 handleStageClick）。 */
  const tapPending = useRef(false);
  const pinchDistance = useRef<number | undefined>(undefined);
  const scaleRef = useRef(1);
  scaleRef.current = scale;

  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    // 捕获阶段监听：浮层是模态的，且 Esc 常被编辑器（CodeMirror、输入框）先持有焦点，
    // 用捕获可避免被它们中途 stopPropagation 掉。
    window.addEventListener("keydown", onKeyDown, true);
    return () => { window.removeEventListener("keydown", onKeyDown, true); };
  }, [onClose]);

  // React 的 onWheel 是 passive 监听，里面 preventDefault 无效，这里挂原生非 passive 监听。
  useEffect(() => {
    const element = overlayRef.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setScale((current) => nextScale(current, event.deltaY < 0 ? 1 : -1));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => { element.removeEventListener("wheel", onWheel); };
  }, []);

  const pointerDistance = (): number | undefined => {
    const [first, second] = [...pointers.current.values()];
    if (first === undefined || second === undefined) return undefined;
    return Math.hypot(second.x - first.x, second.y - first.y);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
    tapPending.current = false;
    if (pointers.current.size === 1) {
      drag.current = {
        startX: event.clientX,
        startY: event.clientY,
        originX: offset.x,
        originY: offset.y,
        fromBackdrop: event.target === event.currentTarget,
        moved: false,
      };
      setDragging(true);
      return;
    }
    // 第二根手指落下即进入双指缩放，放弃单指平移。
    drag.current = undefined;
    setDragging(false);
    pinchDistance.current = pointerDistance();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.current.size >= 2) {
      const distance = pointerDistance();
      const previous = pinchDistance.current;
      pinchDistance.current = distance;
      if (distance === undefined || previous === undefined || previous === 0) return;
      setScale(clampScale(scaleRef.current * (distance / previous)));
      return;
    }

    const current = drag.current;
    if (current === undefined) return;
    const x = event.clientX - current.startX;
    const y = event.clientY - current.startY;
    if (Math.abs(x) > TAP_SLOP || Math.abs(y) > TAP_SLOP) current.moved = true;
    setOffset({ x: current.originX + x, y: current.originY + y });
  };

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinchDistance.current = undefined;
    const current = drag.current;
    drag.current = undefined;
    setDragging(false);
    tapPending.current = current !== undefined && !current.moved && current.fromBackdrop;
  };

  useEffect(() => {
    const stage = stageRef.current;
    return () => {
      if (stage === null) return;
      for (const pointerId of pointers.current.keys()) {
        if (stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
      }
      pointers.current.clear();
    };
  }, []);

  /**
   * 关闭放在 click 而不是 pointerup：触屏下抬手会紧跟一个兼容 click，
   * 若在 pointerup 就卸载浮层，这个 click 会落到下方时间线上（点到图片就立刻重新打开）。
   */
  const handleStageClick = () => {
    if (!tapPending.current) return;
    tapPending.current = false;
    onClose();
  };

  return createPortal(
    <div ref={overlayRef} className="image-lightbox" role="dialog" aria-modal="true" aria-label={alt === "" ? "图片预览" : alt} tabIndex={-1}>
      <div
        ref={stageRef}
        className="image-lightbox-stage"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onClick={handleStageClick}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className={dragging ? "dragging" : undefined}
          style={{ transform: `translate(${String(offset.x)}px, ${String(offset.y)}px) scale(${String(scale)}) rotate(${String(angle)}deg)` }}
        />
      </div>
      <div className="image-lightbox-controls">
        <button type="button" aria-label="缩小" onClick={() => { setScale((current) => nextScale(current, -1)); }}><ZoomOut size={18} /></button>
        <button type="button" aria-label="放大" onClick={() => { setScale((current) => nextScale(current, 1)); }}><ZoomIn size={18} /></button>
        <button type="button" aria-label="向左旋转 90 度" onClick={() => { setAngle((current) => nextAngle(current, -1)); }}><RotateCcw size={18} /></button>
        <button type="button" aria-label="向右旋转 90 度" onClick={() => { setAngle((current) => nextAngle(current, 1)); }}><RotateCw size={18} /></button>
        <button type="button" aria-label="关闭图片预览" onClick={onClose}><X size={18} /></button>
      </div>
    </div>,
    document.body,
  );
}

interface ImagePreviewProps {
  src: string;
  alt?: string;
  className?: string;
  children: ReactNode;
}

/** 缩略图触发器：包住现有按钮/图片即可，浮层状态由组件自己持有。 */
export function ImagePreview({ src, alt = "", className, children }: ImagePreviewProps) {
  const [open, setOpen] = useState(false);
  return <>
    <span className={className} onClick={() => setOpen(true)}>{children}</span>
    {open ? <ImageLightbox src={src} alt={alt} onClose={() => setOpen(false)} /> : null}
  </>;
}
