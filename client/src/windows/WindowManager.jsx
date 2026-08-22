import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useMaterial } from '../material/MaterialProvider';

const STORAGE_KEY = 'cochpia.windows.v2';
const MIN_SIZE = { width: 280, height: 180 };

const createInspectorWindow = () => ({
  id: 'inspector',
  position: { x: Math.max(260, window.innerWidth - 340), y: 96 },
  size: { width: 320, height: Math.min(620, Math.max(520, window.innerHeight - 112)) },
  zIndex: 12,
  minimized: false,
  maximized: false,
  closed: true,
  active: false,
  restoreFrame: null
});

const defaultState = () => ({
  windows: {
    inspector: createInspectorWindow(),
    settings: {
      id: 'settings', position: { x: 120, y: 72 }, size: { width: 760, height: 560 }, zIndex: 9,
      minimized: false, maximized: false, closed: true, active: false, restoreFrame: null
    },
    music: {
      id: 'music', position: { x: 72, y: 132 }, size: { width: 360, height: 460 }, zIndex: 10,
      minimized: false, maximized: false, closed: true, active: false, restoreFrame: null
    }
  },
  activeWindowId: null,
  nextZIndex: 13
});

const normalizeWindow = (windowRecord, fallback) => ({
  ...(() => {
    const rawPosition = { ...fallback.position, ...(windowRecord?.position || {}) };
    const maxWidth = Math.max(MIN_SIZE.width, window.innerWidth - 32);
    const maxHeight = Math.max(MIN_SIZE.height, window.innerHeight - 112);
    const width = Math.min(maxWidth, Math.max(MIN_SIZE.width, Number(windowRecord?.size?.width) || fallback.size.width));
    const height = Math.min(maxHeight, Math.max(MIN_SIZE.height, Number(windowRecord?.size?.height) || fallback.size.height));
    return {
      ...fallback,
      ...windowRecord,
      position: {
        x: Math.min(Math.max(16, Number(rawPosition.x) || 16), Math.max(16, window.innerWidth - width - 16)),
        y: Math.min(Math.max(16, Number(rawPosition.y) || 16), Math.max(16, window.innerHeight - height - 16))
      },
      size: { width, height }
    };
  })()
});

const readStoredState = () => {
  const fallback = defaultState();
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    if (!stored?.windows?.inspector) return fallback;
    return {
      ...fallback,
      ...stored,
      windows: {
        inspector: normalizeWindow(stored.windows.inspector, fallback.windows.inspector),
        settings: normalizeWindow(stored.windows.settings, fallback.windows.settings),
        music: normalizeWindow(stored.windows.music, fallback.windows.music)
      }
    };
  } catch {
    return fallback;
  }
};

const withActiveWindow = (state, id, nextZIndex = state.nextZIndex) => ({
  ...state,
  activeWindowId: id,
  nextZIndex: nextZIndex + 1,
  windows: Object.fromEntries(Object.entries(state.windows).map(([windowId, windowRecord]) => [windowId, {
    ...windowRecord,
    active: windowId === id,
    zIndex: windowId === id ? nextZIndex : windowRecord.zIndex
  }]))
});

const reducer = (state, action) => {
  const current = state.windows[action.id];
  if (!current && action.type !== 'REGISTER_WINDOW') return state;
  switch (action.type) {
    case 'REGISTER_WINDOW':
      return state.windows[action.window.id] ? state : { ...state, windows: { ...state.windows, [action.window.id]: action.window } };
    case 'FOCUS_WINDOW':
      return withActiveWindow(state, action.id);
    case 'MOVE_WINDOW':
      return { ...state, windows: { ...state.windows, [action.id]: { ...current, position: action.position } } };
    case 'RESIZE_WINDOW':
      return { ...state, windows: { ...state.windows, [action.id]: { ...current, size: { width: Math.max(MIN_SIZE.width, action.size.width), height: Math.max(MIN_SIZE.height, action.size.height) } } } };
    case 'MINIMIZE_WINDOW':
      return { ...state, windows: { ...state.windows, [action.id]: { ...current, minimized: true, active: false } }, activeWindowId: state.activeWindowId === action.id ? null : state.activeWindowId };
    case 'RESTORE_WINDOW':
      return withActiveWindow({ ...state, windows: { ...state.windows, [action.id]: { ...current, minimized: false, closed: false } } }, action.id);
    case 'MAXIMIZE_WINDOW':
      return { ...state, windows: { ...state.windows, [action.id]: { ...current, maximized: true, restoreFrame: { position: current.position, size: current.size } } } };
    case 'RESTORE_MAXIMIZED_WINDOW':
      return { ...state, windows: { ...state.windows, [action.id]: { ...current, maximized: false, restoreFrame: null, ...(current.restoreFrame || {}) } } };
    case 'CLOSE_WINDOW':
      return { ...state, windows: { ...state.windows, [action.id]: { ...current, closed: true, minimized: false, active: false } }, activeWindowId: state.activeWindowId === action.id ? null : state.activeWindowId };
    case 'RESET_WINDOWS':
      return defaultState();
    default:
      return state;
  }
};

const WindowManagerContext = createContext(null);

export function WindowManagerProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, readStoredState);

  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Workspace persistence is optional. */ }
  }, [state]);

  const value = useMemo(() => ({
    state,
    registerWindow: windowRecord => dispatch({ type: 'REGISTER_WINDOW', window: windowRecord }),
    focusWindow: id => dispatch({ type: 'FOCUS_WINDOW', id }),
    moveWindow: (id, position) => dispatch({ type: 'MOVE_WINDOW', id, position }),
    resizeWindow: (id, size) => dispatch({ type: 'RESIZE_WINDOW', id, size }),
    minimizeWindow: id => dispatch({ type: 'MINIMIZE_WINDOW', id }),
    restoreWindow: id => dispatch({ type: 'RESTORE_WINDOW', id }),
    maximizeWindow: id => dispatch({ type: 'MAXIMIZE_WINDOW', id }),
    restoreMaximizedWindow: id => dispatch({ type: 'RESTORE_MAXIMIZED_WINDOW', id }),
    closeWindow: id => dispatch({ type: 'CLOSE_WINDOW', id }),
    resetWindows: () => dispatch({ type: 'RESET_WINDOWS' })
  }), [state]);

  return <WindowManagerContext.Provider value={value}>{children}</WindowManagerContext.Provider>;
}
export const useWindowManager = () => {
  const value = useContext(WindowManagerContext);
  if (!value) throw new Error('useWindowManager must be used inside WindowManagerProvider');
  return value;
};

export function FloatingWindow({ id, title, children }) {
  const { state, focusWindow, moveWindow, resizeWindow, minimizeWindow, restoreWindow, maximizeWindow, restoreMaximizedWindow, closeWindow } = useWindowManager();
  const { getMaterialStyle } = useMaterial();
  const windowRecord = state.windows[id];
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [resizeSize, setResizeSize] = useState(null);
  const [exited, setExited] = useState(Boolean(windowRecord?.closed));
  const dragRef = useRef(null);
  const resizeRef = useRef(null);
  const frameRef = useRef(null);
  const interactionCleanupRef = useRef(null);

  useEffect(() => {
    if (!windowRecord?.closed) {
      setExited(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setExited(true), 320);
    return () => window.clearTimeout(timer);
  }, [windowRecord?.closed]);

  useEffect(() => () => {
    interactionCleanupRef.current?.();
    if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
  }, []);

  if (!windowRecord || exited) return null;

  const commitDrag = () => {
    const drag = dragRef.current;
    if (!drag) return;
    moveWindow(id, { x: drag.startPosition.x + drag.currentOffset.x, y: drag.startPosition.y + drag.currentOffset.y });
    dragRef.current = null;
    setDragOffset({ x: 0, y: 0 });
    setDragging(false);
  };

  const commitResize = () => {
    const resize = resizeRef.current;
    if (!resize) return;
    resizeWindow(id, resize.currentSize);
    resizeRef.current = null;
    setResizeSize(null);
    setResizing(false);
  };

  const onPointerMove = event => {
    if (dragRef.current) {
      const nextOffset = { x: event.clientX - dragRef.current.startPoint.x, y: event.clientY - dragRef.current.startPoint.y };
      dragRef.current.currentOffset = nextOffset;
      if (!frameRef.current) frameRef.current = window.requestAnimationFrame(() => { setDragOffset(dragRef.current?.currentOffset || { x: 0, y: 0 }); frameRef.current = null; });
    }
    if (resizeRef.current) {
      const nextSize = { width: Math.max(MIN_SIZE.width, resizeRef.current.startSize.width + event.clientX - resizeRef.current.startPoint.x), height: Math.max(MIN_SIZE.height, resizeRef.current.startSize.height + event.clientY - resizeRef.current.startPoint.y) };
      resizeRef.current.currentSize = nextSize;
      if (!frameRef.current) frameRef.current = window.requestAnimationFrame(() => { setResizeSize(resizeRef.current?.currentSize || null); frameRef.current = null; });
    }
  };

  const onPointerUp = () => {
    if (dragRef.current) commitDrag();
    if (resizeRef.current) commitResize();
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('mouseup', onPointerUp);
    interactionCleanupRef.current = null;
  };

  const startDrag = event => {
    if (event.button !== 0 || event.target.closest('button, input, select, textarea')) return;
    focusWindow(id);
    interactionCleanupRef.current?.();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { startPoint: { x: event.clientX, y: event.clientY }, startPosition: windowRecord.position, currentOffset: { x: 0, y: 0 } };
    setDragging(true);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
    window.addEventListener('pointercancel', onPointerUp, { once: true });
    window.addEventListener('mouseup', onPointerUp, { once: true });
    interactionCleanupRef.current = () => { window.removeEventListener('pointermove', onPointerMove); window.removeEventListener('pointerup', onPointerUp); window.removeEventListener('pointercancel', onPointerUp); window.removeEventListener('mouseup', onPointerUp); dragRef.current = null; resizeRef.current = null; };
  };

  const startResize = event => {
    event.stopPropagation();
    focusWindow(id);
    interactionCleanupRef.current?.();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    resizeRef.current = { startPoint: { x: event.clientX, y: event.clientY }, startSize: windowRecord.size, currentSize: windowRecord.size };
    setResizing(true);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
    window.addEventListener('pointercancel', onPointerUp, { once: true });
    window.addEventListener('mouseup', onPointerUp, { once: true });
    interactionCleanupRef.current = () => { window.removeEventListener('pointermove', onPointerMove); window.removeEventListener('pointerup', onPointerUp); window.removeEventListener('pointercancel', onPointerUp); window.removeEventListener('mouseup', onPointerUp); dragRef.current = null; resizeRef.current = null; };
  };

  const style = {
    left: `${windowRecord.position.x}px`,
    top: `${windowRecord.position.y}px`,
    width: `${resizeSize?.width || windowRecord.size.width}px`,
    height: `${resizeSize?.height || windowRecord.size.height}px`,
    zIndex: windowRecord.zIndex,
    ...getMaterialStyle(id),
    transform: `translate3d(${dragOffset.x}px, ${dragOffset.y}px, 0)${dragging ? ' scale(1.01)' : ''}`
  };

  return <section className={`floating-window ${windowRecord.active ? 'is-active' : ''} ${dragging ? 'is-dragging' : ''} ${resizing ? 'is-resizing' : ''} ${windowRecord.minimized ? 'is-minimized' : ''} ${windowRecord.maximized ? 'is-maximized' : ''} ${windowRecord.closed ? 'is-closing' : ''}`} style={style} aria-label={title} onPointerDown={() => focusWindow(id)}>
    <header className="floating-window-header" onPointerDown={startDrag}><strong>{title}</strong><div className="floating-window-actions"><button type="button" aria-label={`最小化${title}`} title="最小化" onClick={() => minimizeWindow(id)}>−</button><button type="button" aria-label={windowRecord.maximized ? `恢复${title}` : `最大化${title}`} title={windowRecord.maximized ? '恢复' : '最大化'} onClick={() => windowRecord.maximized ? restoreMaximizedWindow(id) : maximizeWindow(id)}>{windowRecord.maximized ? '↙' : '□'}</button><button type="button" aria-label={`关闭${title}`} title="关闭" onClick={() => closeWindow(id)}>×</button></div></header>
    <div className="floating-window-content">{children}</div>
    <button type="button" className="floating-window-resize" aria-label={`调整${title}大小`} title="调整窗口大小" onPointerDown={startResize} />
  </section>;
}
