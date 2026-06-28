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
};

/**
 * On mobile/tablet, Obsidian Canvas auto-zooms out when the keyboard opens for
 * card editing. Block that auto-zoom while a node is actively being edited.
 *
 * Does NOT lock the viewport on mere taps — pan/zoom/wheel controls keep working
 * until edit mode actually starts.
 */
export function registerMobileEditViewportLock(canvas: Canvas): () => void {
	if (!isMobileApp()) return () => {};

	const c = canvas as CanvasWithViewport;
	const wrapper = canvas.wrapperEl;
	if (!wrapper) return () => {};

	let saved: ViewportSnapshot | null = null;
	let preEditSnapshot: ViewportSnapshot | null = null;
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

	const clearEditLock = (): void => {
		saved = null;
		preEditSnapshot = null;
		stopPoll();
	};

	const restoreViewport = (): void => {
		if (!saved || !anyNodeEditing()) return;
		applyViewport(saved);
	};

	const scheduleRestore = (): void => {
		if (!saved || !anyNodeEditing()) return;
		if (restoreRaf) cancelAnimationFrame(restoreRaf);
		restoreRaf = requestAnimationFrame(() => {
			restoreRaf = 0;
			restoreViewport();
		});
	};

	const startPoll = (): void => {
		stopPoll();
		let ticks = 0;
		pollTimer = setInterval(() => {
			if (!saved || !anyNodeEditing()) {
				clearEditLock();
				return;
			}
			restoreViewport();
			ticks++;
			if (ticks > 30) stopPoll();
		}, 50);
	};

	const beginEditLock = (): void => {
		if (!anyNodeEditing()) return;
		saved = preEditSnapshot ?? snapshot();
		scheduleRestore();
		startPoll();
	};

	/** Block Obsidian's fit-to-card zoom during edit — not user pan/zoom/wheel. */
	const wrapEditZoom = <T extends (...args: never[]) => void>(orig: T): T => {
		const wrapped = ((...args: never[]) => {
			if (!anyNodeEditing()) {
				orig(...args);
				return;
			}
			scheduleRestore();
		}) as T;
		return wrapped;
	};

	const origZoomToBbox = canvas.zoomToBbox.bind(canvas);
	const origZoomToSelection = canvas.zoomToSelection.bind(canvas);
	const origZoomToFit = canvas.zoomToFit?.bind(canvas);
	const origPanIntoView = c.panIntoView?.bind(c);

	canvas.zoomToBbox = wrapEditZoom(origZoomToBbox);
	canvas.zoomToSelection = wrapEditZoom(origZoomToSelection);
	if (origZoomToFit) canvas.zoomToFit = wrapEditZoom(origZoomToFit);
	if (origPanIntoView) c.panIntoView = wrapEditZoom(origPanIntoView as (...args: never[]) => void);

	const onPointerDown = (e: PointerEvent) => {
		if (e.pointerType === "mouse") return;
		const target = e.target as HTMLElement;
		if (!target.closest(".canvas-node")) return;
		if (target.closest(".mindvas-fold-chevron")) return;
		// Remember viewport before Obsidian opens the editor — do not lock yet.
		preEditSnapshot = snapshot();
	};

	const onFocusIn = (e: FocusEvent) => {
		const target = e.target as HTMLElement;
		if (!target.closest?.(".canvas-node")) return;
		queueMicrotask(() => beginEditLock());
	};

	const onFocusOut = () => {
		setTimeout(() => {
			if (!anyNodeEditing()) clearEditLock();
		}, 150);
	};

	const onViewportResize = () => {
		if (anyNodeEditing()) scheduleRestore();
	};

	const opts = { passive: true } as AddEventListenerOptions;
	wrapper.addEventListener("pointerdown", onPointerDown, opts);
	wrapper.addEventListener("focusin", onFocusIn, true);
	wrapper.addEventListener("focusout", onFocusOut, true);
	window.visualViewport?.addEventListener("resize", onViewportResize);

	return () => {
		clearEditLock();
		canvas.zoomToBbox = origZoomToBbox;
		canvas.zoomToSelection = origZoomToSelection;
		if (origZoomToFit) canvas.zoomToFit = origZoomToFit;
		if (origPanIntoView) c.panIntoView = origPanIntoView;
		wrapper.removeEventListener("pointerdown", onPointerDown, opts);
		wrapper.removeEventListener("focusin", onFocusIn, true);
		wrapper.removeEventListener("focusout", onFocusOut, true);
		window.visualViewport?.removeEventListener("resize", onViewportResize);
	};
}
