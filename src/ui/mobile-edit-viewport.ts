import type { Canvas } from "../types/canvas-internal";
import { isMobileApp } from "./mobile-utils";

interface ViewportSnapshot {
	tx: number;
	ty: number;
	zoom: number;
	tZoom: number;
}

type CanvasWithViewport = Canvas & {
	setViewport?: (tx: number, ty: number, zoom: number) => void;
	markViewportChanged?: () => void;
	panIntoView?: (...args: unknown[]) => void;
	smartZoom?: (...args: unknown[]) => void;
};

/**
 * On mobile/tablet, Obsidian Canvas auto-zooms out when the keyboard opens for
 * card editing. Lock the viewport at the current zoom/pan while a node is edited.
 */
export function registerMobileEditViewportLock(canvas: Canvas): () => void {
	if (!isMobileApp()) return () => {};

	const c = canvas as CanvasWithViewport;
	const wrapper = canvas.wrapperEl;
	if (!wrapper) return () => {};

	let locked = false;
	let saved: ViewportSnapshot | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let restoreRaf = 0;

	const snapshot = (): ViewportSnapshot => ({
		tx: canvas.tx,
		ty: canvas.ty,
		zoom: canvas.zoom,
		tZoom: canvas.tZoom,
	});

	const applyViewport = (v: ViewportSnapshot): void => {
		const scale = v.tZoom || v.zoom;
		if (typeof c.setViewport === "function") {
			c.setViewport(v.tx, v.ty, scale);
		} else {
			canvas.tx = v.tx;
			canvas.ty = v.ty;
			canvas.tZoom = scale;
			canvas.zoom = scale;
		}
		c.markViewportChanged?.();
		canvas.requestFrame();
	};

	const anyNodeEditing = (): boolean => {
		for (const node of canvas.nodes.values()) {
			if (node.isEditing) return true;
		}
		return false;
	};

	const stopPoll = (): void => {
		if (pollTimer !== null) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		if (restoreRaf) {
			cancelAnimationFrame(restoreRaf);
			restoreRaf = 0;
		}
	};

	const restoreViewport = (): void => {
		if (!locked || !saved) return;
		applyViewport(saved);
	};

	const scheduleRestore = (): void => {
		if (!locked || !saved) return;
		if (restoreRaf) cancelAnimationFrame(restoreRaf);
		restoreRaf = requestAnimationFrame(() => {
			restoreRaf = 0;
			restoreViewport();
			requestAnimationFrame(restoreViewport);
		});
	};

	const startPoll = (): void => {
		stopPoll();
		let ticks = 0;
		pollTimer = setInterval(() => {
			if (!locked || !saved) {
				stopPoll();
				return;
			}
			restoreViewport();
			ticks++;
			if (ticks > 30 || !anyNodeEditing()) stopPoll();
		}, 50);
	};

	const lockViewport = (): void => {
		saved = snapshot();
		locked = true;
		scheduleRestore();
		startPoll();
	};

	const unlockViewport = (): void => {
		locked = false;
		saved = null;
		stopPoll();
	};

	const shouldBlockZoom = (): boolean => locked || anyNodeEditing();

	const wrapNoZoom = <T extends (...args: never[]) => void>(orig: T): T => {
		const wrapped = ((...args: never[]) => {
			if (shouldBlockZoom()) {
				scheduleRestore();
				return;
			}
			orig(...args);
		}) as T;
		return wrapped;
	};

	const origZoomToBbox = canvas.zoomToBbox.bind(canvas);
	const origZoomToSelection = canvas.zoomToSelection.bind(canvas);
	const origZoomToFit = canvas.zoomToFit?.bind(canvas);
	const origPanIntoView = c.panIntoView?.bind(c);
	const origSmartZoom = c.smartZoom?.bind(c);

	canvas.zoomToBbox = wrapNoZoom(origZoomToBbox);
	canvas.zoomToSelection = wrapNoZoom(origZoomToSelection);
	if (origZoomToFit) canvas.zoomToFit = wrapNoZoom(origZoomToFit);
	if (origPanIntoView) c.panIntoView = wrapNoZoom(origPanIntoView as (...args: never[]) => void);
	if (origSmartZoom) c.smartZoom = wrapNoZoom(origSmartZoom as (...args: never[]) => void);

	const onPointerDown = (e: PointerEvent) => {
		if (e.pointerType === "mouse") return;
		const target = e.target as HTMLElement;
		if (!target.closest(".canvas-node")) return;
		if (target.closest(".mindvas-fold-chevron")) return;
		lockViewport();
	};

	const onFocusIn = (e: FocusEvent) => {
		const target = e.target as HTMLElement;
		if (!target.closest?.(".canvas-node")) return;
		if (!locked) lockViewport();
		else scheduleRestore();
	};

	const onFocusOut = () => {
		setTimeout(() => {
			if (!anyNodeEditing()) unlockViewport();
		}, 150);
	};

	const onViewportResize = () => {
		if (locked) scheduleRestore();
	};

	wrapper.addEventListener("pointerdown", onPointerDown, true);
	wrapper.addEventListener("focusin", onFocusIn, true);
	wrapper.addEventListener("focusout", onFocusOut, true);
	window.visualViewport?.addEventListener("resize", onViewportResize);

	return () => {
		unlockViewport();
		canvas.zoomToBbox = origZoomToBbox;
		canvas.zoomToSelection = origZoomToSelection;
		if (origZoomToFit) canvas.zoomToFit = origZoomToFit;
		if (origPanIntoView) c.panIntoView = origPanIntoView;
		if (origSmartZoom) c.smartZoom = origSmartZoom;
		wrapper.removeEventListener("pointerdown", onPointerDown, true);
		wrapper.removeEventListener("focusin", onFocusIn, true);
		wrapper.removeEventListener("focusout", onFocusOut, true);
		window.visualViewport?.removeEventListener("resize", onViewportResize);
	};
}
