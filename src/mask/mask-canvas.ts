import type { App } from "obsidian";
import { TFile } from "obsidian";
import type { Canvas, CanvasNode } from "../types/canvas-internal";
import {
	getMaskOverlayHost,
	hasInlineMasks,
	maskItemKey,
	parseInlineMasks,
	normalizeMaskSyntax,
	noteMaskItemKey,
} from "./mask-core";
import { trackCanvasSelection } from "./mask-selection";
import { isRevealed, toggleRevealed } from "./mask-reveal";
import {
	isNodeMasked,
	coverAllMasks,
	revealAllMasks,
} from "./mask-study";
import {
	createMaskTapeElement,
	findNodePreviewRoot,
	previewHasMaskTags,
	stripAllMaskWraps,
	collectMaskRoots,
} from "./mask-dom";
import { cleanupMaskTagRemnants, markdownToPlainDisplay } from "./mask-source";
import { attachTapeToggle, getNodeMaskColor } from "./mask-core";
import { wrapCanvasSelection as wrapSel } from "./mask-core";
import { applyMaskColorClass } from "./mask-colors";
import { scanCanvasEditingNodes } from "./mask-canvas-editor-inject";
import { getCanvasNodeMaskSource } from "./mask-canvas-preview";
import {
	isTextCardReadMode,
	isTextCardEditing,
	syncTextCardReadMask,
	syncAllTextCardMasksOnCanvas,
	clearTextCardOverlay,
	textCardMaskApplied,
	textCardOverlayApplied,
	resolveTextCardHost,
	applyCanvasNodeInPreviewMasks,
} from "./mask-canvas-text";
import {
	isTextCanvasNode,
	isFileCanvasNode,
	isMaskableCanvasNode,
} from "./mask-canvas-node";

export {
	getNodeMaskColor,
	setNodeMaskColor,
	wrapInlineMask,
	normalizeMaskSyntax,
	DEFAULT_MASK_COLOR,
	type MaskColor,
} from "./mask-core";
export {
	toggleNodeMask,
	isNodeMasked,
	countAllMasks,
	coverAllMasks,
	revealAllMasks,
} from "./mask-study";

import type { MaskColor } from "./mask-core";
import { getLastMaskColor } from "./mask-colors";
import { isMobileApp } from "../ui/mobile-utils";

export function wrapCanvasSelection(
	node: CanvasNode,
	color?: MaskColor,
	app?: App
): boolean {
	const ok = wrapSel(node, color ?? getLastMaskColor());
	if (!ok) return false;
	if (app && isFileCanvasNode(node)) {
		const path = resolveCanvasFilePath(node);
		const file = path ? app.vault.getAbstractFileByPath(path) : null;
		if (file instanceof TFile) {
			void app.vault.modify(file, node.text);
		}
	}
	return true;
}

export function resolveCanvasFilePath(node: CanvasNode): string | null {
	const runtimeFile = node.file;
	if (typeof runtimeFile === "string" && runtimeFile.trim()) return runtimeFile;
	if (runtimeFile && typeof runtimeFile === "object") {
		const fileObj = runtimeFile as { path?: string; file?: string };
		const path = fileObj.path ?? fileObj.file;
		if (typeof path === "string" && path.trim()) return path;
	}

	const data = node.canvas.getData().nodes.find((n) => n.id === node.id);
	if (typeof data?.file === "string" && data.file.trim()) return data.file;
	return null;
}

export async function persistCanvasFileNodeContent(
	app: App,
	node: CanvasNode,
	content: string
): Promise<boolean> {
	const path = resolveCanvasFilePath(node);
	if (!path) return false;
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return false;
	node.setText(content);
	await app.vault.modify(file, content);
	return true;
}

function resolveFilePath(node: CanvasNode): string | null {
	return resolveCanvasFilePath(node);
}

function maskKeyFor(node: CanvasNode, canvasPath: string): (index: number) => string {
	const path = resolveCanvasFilePath(node);
	if (path) return (i: number) => noteMaskItemKey(path, i);
	return (i: number) => maskItemKey(canvasPath, node.id, i);
}

function getNodeTextSource(node: CanvasNode): string {
	return getCanvasNodeMaskSource(node);
}

function extractDomMaskSource(nodeEl: HTMLElement): string | null {
	const root = findNodePreviewRoot(nodeEl) ?? nodeEl;
	const text = normalizeMaskSyntax(root.textContent ?? "");
	return hasInlineMasks(text) ? text : null;
}

function resolveInlineMaskContent(node: CanvasNode): string | null {
	const fromNode = getNodeTextSource(node);
	if (hasInlineMasks(fromNode)) return fromNode;
	if (!node.nodeEl) return null;
	return extractDomMaskSource(node.nodeEl);
}

function getMaskHosts(node: CanvasNode): HTMLElement[] {
	const hosts: HTMLElement[] = [];
	if (node.nodeEl) hosts.push(node.nodeEl);
	if (node.contentEl && node.contentEl !== node.nodeEl) hosts.push(node.contentEl);
	return hosts;
}

/** Read mode: text cards use dedicated overlay; file cards use nodeEl layer. */
function applyInlineMasksToNode(
	node: CanvasNode,
	content: string,
	canvasPath: string
): void {
	if (!hasInlineMasks(content)) return;

	if (isTextCanvasNode(node)) {
		if (!isTextCardReadMode(node)) return;
		syncTextCardReadMask(node, canvasPath);
		return;
	}

	if (node.isEditing) return;
	if (!node.nodeEl) return;
	// File embeds: in-preview tape only — keep native markdown + branch color.
	removeInlinePreview(node);
	applyCanvasNodeInPreviewMasks(node, content, canvasPath);
}

function applyFileNodeInlineMasks(node: CanvasNode, content: string, canvasPath: string): void {
	applyInlineMasksToNode(node, content, canvasPath);
}

const iframeWatchGeneration = new WeakMap<HTMLIFrameElement, number>();

function watchFileNodeIframe(node: CanvasNode, onLoad: () => void): void {
	if (!node.nodeEl) return;
	const iframe = node.nodeEl.querySelector<HTMLIFrameElement>("iframe");
	if (!iframe) return;

	const gen = (iframeWatchGeneration.get(iframe) ?? 0) + 1;
	iframeWatchGeneration.set(iframe, gen);

	const schedule = () => {
		if (iframeWatchGeneration.get(iframe) !== gen) return;
		onLoad();
	};

	iframe.addEventListener("load", schedule, { passive: true });
	window.setTimeout(schedule, 0);
	window.setTimeout(schedule, 350);
	window.setTimeout(schedule, 900);
}

function setIframeVisible(node: CanvasNode, visible: boolean): void {
	if (!node.nodeEl) return;
	setIframeVisibleFromHost(node.nodeEl, visible);
}

function ensureWholeNodeOverlay(node: CanvasNode, canvasPath: string, onRefresh: () => void): void {
	const host = getMaskOverlayHost(node);
	if (!host) return;

	const key = maskItemKey(canvasPath, node.id);
	const revealed = isRevealed(key);

	let overlay = host.querySelector(":scope > .mindvas-mask-tape") as HTMLButtonElement | null;
	if (!overlay) {
		overlay = document.createElement("button");
		overlay.type = "button";
		overlay.className = "mindvas-mask-tape mindvas-mask-ui";
		overlay.dataset.mindvasKey = key;
		overlay.setAttribute("aria-label", "탭하여 보기");
		attachTapeToggle(overlay);
		host.style.position = "relative";
		host.appendChild(overlay);
	}

	overlay.dataset.mindvasKey = key;
	const nodeColor = getNodeMaskColor(node.canvas, node.id) ?? "yellow";
	applyMaskColorClass(overlay, nodeColor);

	if (revealed) {
		overlay.classList.add("is-revealed");
		overlay.textContent = "가리기";
		node.nodeEl?.classList.add("mindvas-mask-revealed");
		node.nodeEl?.classList.remove("mindvas-has-mask");
	} else {
		overlay.classList.remove("is-revealed");
		overlay.textContent = "";
		node.nodeEl?.classList.add("mindvas-has-mask");
		node.nodeEl?.classList.remove("mindvas-mask-revealed");
	}
}

function removeWholeNodeOverlay(node: CanvasNode): void {
	getMaskOverlayHost(node)?.querySelector(":scope > .mindvas-mask-tape")?.remove();
	node.nodeEl?.classList.remove("mindvas-has-mask", "mindvas-mask-revealed");
}

function setIframeVisibleFromHost(host: HTMLElement, visible: boolean): void {
	for (const iframe of Array.from(host.querySelectorAll<HTMLIFrameElement>("iframe"))) {
		iframe.style.opacity = visible ? "" : "0";
		iframe.style.pointerEvents = visible ? "" : "none";
	}
}

function removeInlinePreview(node: CanvasNode): void {
	if (isTextCanvasNode(node)) {
		clearTextCardOverlay(node);
		return;
	}
	for (const host of getMaskHosts(node)) {
		host.querySelector(":scope > .mindvas-mask-preview")?.remove();
		host.classList.remove("mindvas-has-inline-mask");
		for (const el of Array.from(host.querySelectorAll(".mindvas-native-hidden"))) {
			el.classList.remove("mindvas-native-hidden");
		}
	}
	node.nodeEl?.classList.remove("mindvas-has-inline-mask");
	if (node.nodeEl) setIframeVisibleFromHost(node.nodeEl, true);
}

async function readVaultFile(app: App, path: string): Promise<string | null> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return null;
	try {
		return await app.vault.read(file);
	} catch {
		return null;
	}
}

const fileSyncGeneration = new WeakMap<CanvasNode, number>();

async function syncFileNodeFromVault(
	node: CanvasNode,
	app: App,
	canvasPath: string,
	_onRefresh: () => void
): Promise<void> {
	if (!node.nodeEl || node.isEditing) return;

	const gen = (fileSyncGeneration.get(node) ?? 0) + 1;
	fileSyncGeneration.set(node, gen);

	const path = resolveFilePath(node);
	let source: string | null = null;
	if (path) {
		source = await readVaultFile(app, path);
	}
	if (fileSyncGeneration.get(node) !== gen) return;

	if (!source || !hasInlineMasks(source)) {
		const fromNode = getNodeTextSource(node);
		if (hasInlineMasks(fromNode)) source = fromNode;
	}
	if ((!source || !hasInlineMasks(source)) && node.nodeEl) {
		source = extractDomMaskSource(node.nodeEl);
	}

	if (!source || !hasInlineMasks(source)) {
		removeInlinePreview(node);
		if (node.nodeEl) {
			for (const root of collectMaskRoots(node.nodeEl)) {
				stripAllMaskWraps(root);
				cleanupMaskTagRemnants(root);
			}
		}
		setIframeVisible(node, true);
		return;
	}

	if (isNodeMasked(node.canvas, node.id)) return;

	applyFileNodeInlineMasks(node, source, canvasPath);
}

function syncOneNode(
	node: CanvasNode,
	canvasPath: string,
	onRefresh: () => void,
	app: App
): void {
	if (!isMaskableCanvasNode(node)) {
		removeWholeNodeOverlay(node);
		removeInlinePreview(node);
		return;
	}

	if (!node.isEditing && node.text?.includes("[[mv:")) {
		const fixed = normalizeMaskSyntax(node.text);
		if (fixed !== node.text) node.setText(fixed);
	}

	if (isTextCanvasNode(node) && (node.isEditing || isTextCardEditing(node))) {
		removeWholeNodeOverlay(node);
		removeInlinePreview(node);
		scanCanvasEditingNodes([node]);
		return;
	}

	if (!isTextCanvasNode(node) && node.isEditing) {
		removeWholeNodeOverlay(node);
		removeInlinePreview(node);
		scanCanvasEditingNodes([node]);
		return;
	}

	if (isNodeMasked(node.canvas, node.id)) {
		removeInlinePreview(node);
		setIframeVisible(node, true);
		ensureWholeNodeOverlay(node, canvasPath, onRefresh);
		return;
	}

	removeWholeNodeOverlay(node);

	if (isFileCanvasNode(node)) {
		watchFileNodeIframe(node, onRefresh);
		void syncFileNodeFromVault(node, app, canvasPath, onRefresh);
		if (!node.nodeEl) return;
		if (!node.nodeEl.dataset.mindvasMaskPending) {
			node.nodeEl.dataset.mindvasMaskPending = "1";
			window.setTimeout(() => {
				delete node.nodeEl?.dataset.mindvasMaskPending;
				void syncFileNodeFromVault(node, app, canvasPath, onRefresh);
			}, 400);
			window.setTimeout(() => {
				void syncFileNodeFromVault(node, app, canvasPath, onRefresh);
			}, 1200);
		}
		return;
	}

	const inlineContent = resolveInlineMaskContent(node);
	if (inlineContent) {
		applyInlineMasksToNode(node, inlineContent, canvasPath);
		if (isTextCanvasNode(node)) scheduleTextNodeMaskRetries(node, canvasPath, onRefresh, app);
		return;
	}

	// Text nodes: apply from canvas JSON even when node.text / DOM extraction failed.
	if (isTextCanvasNode(node)) {
		const source = getCanvasNodeMaskSource(node);
		if (hasInlineMasks(source) && isTextCardReadMode(node)) {
			syncTextCardReadMask(node, canvasPath);
			scheduleTextNodeMaskRetries(node, canvasPath, onRefresh, app);
			return;
		}
	}

	removeInlinePreview(node);
}

const textSyncGeneration = new WeakMap<CanvasNode, number>();

function scheduleTextNodeMaskRetries(
	node: CanvasNode,
	canvasPath: string,
	onRefresh: () => void,
	app: App
): void {
	if (!isTextCanvasNode(node)) return;
	const gen = (textSyncGeneration.get(node) ?? 0) + 1;
	textSyncGeneration.set(node, gen);

	const retry = () => {
		if (textSyncGeneration.get(node) !== gen || !isTextCardReadMode(node)) return;
		const content = resolveInlineMaskContent(node);
		if (!content) return;
		if (textCardMaskApplied(node, content)) return;
		syncOneNode(node, canvasPath, onRefresh, app);
	};

	for (const ms of [0, 50, 150, 350, 700, 1500, 3000]) {
		window.setTimeout(retry, ms);
	}
	requestAnimationFrame(() => requestAnimationFrame(retry));
}

const nodeMaskWatchers = new WeakMap<CanvasNode, MutationObserver>();
const nodeWasEditing = new WeakMap<CanvasNode, boolean>();

function ensureNodeMaskWatch(
	node: CanvasNode,
	canvasPath: string,
	app: App,
	refresh: () => void
): void {
	if (nodeMaskWatchers.has(node)) return;
	const host = isTextCanvasNode(node) ? resolveTextCardHost(node) : node.nodeEl;
	if (!host) return;

	const observer = new MutationObserver(() => {
		if (isTextCanvasNode(node) && !isTextCardReadMode(node)) return;
		if (!isTextCanvasNode(node) && node.isEditing) return;
		const needsMask =
			hasInlineMasks(getNodeTextSource(node)) || previewHasMaskTags(node.nodeEl);
		const content = resolveInlineMaskContent(node);
		const hasOverlay = content
			? textCardMaskApplied(node, content)
			: textCardMaskApplied(node);
		if (needsMask && !hasOverlay) {
			syncOneNode(node, canvasPath, refresh, app);
		}
	});
	observer.observe(host, {
		subtree: true,
		childList: true,
		characterData: true,
	});
	nodeMaskWatchers.set(node, observer);
}

function clearNodeMaskWatch(node: CanvasNode): void {
	nodeMaskWatchers.get(node)?.disconnect();
	nodeMaskWatchers.delete(node);
}

function schedulePostEditBlurSync(refresh: () => void): void {
	for (const ms of [0, 80, 200, 500, 1200]) {
		window.setTimeout(refresh, ms);
	}
}

export function syncCanvasMaskUI(canvas: Canvas, canvasPath: string, app: App): void {
	const onRefresh = () => syncCanvasMaskUI(canvas, canvasPath, app);
	syncAllTextCardMasksOnCanvas(canvasPath, canvas.nodes.values());
	let anyBlur = false;
	for (const node of canvas.nodes.values()) {
		const wasEditing = nodeWasEditing.get(node) ?? false;
		if (wasEditing && !node.isEditing) anyBlur = true;
		nodeWasEditing.set(node, node.isEditing);
		syncOneNode(node, canvasPath, onRefresh, app);
		if (!node.isEditing && isMaskableCanvasNode(node)) {
			const content = resolveInlineMaskContent(node);
			if (content) ensureNodeMaskWatch(node, canvasPath, app, onRefresh);
			else clearNodeMaskWatch(node);
		} else {
			clearNodeMaskWatch(node);
		}
	}
	if (anyBlur) schedulePostEditBlurSync(onRefresh);
}

export function clearCanvasMaskUI(canvas: Canvas): void {
	for (const node of canvas.nodes.values()) {
		clearNodeMaskWatch(node);
		removeWholeNodeOverlay(node);
		removeInlinePreview(node);
	}
}

export function refreshCanvasMaskUI(canvas: Canvas, canvasPath: string, app: App): void {
	syncCanvasMaskUI(canvas, canvasPath, app);
}

/** Refresh every open canvas view (e.g. after a linked note file changes). */
export function refreshAllCanvasMasks(app: App): void {
	for (const leaf of app.workspace.getLeavesOfType("canvas")) {
		const view = leaf.view as { canvas?: Canvas; file?: { path?: string } };
		const canvas = view?.canvas;
		if (!canvas) continue;
		const canvasPath = view.file?.path ?? "";
		refreshCanvasMaskUI(canvas, canvasPath, app);
		canvas.requestFrame();
	}
}

export function registerCanvasMaskHandler(
	canvas: Canvas,
	canvasPath: string,
	app: App
): () => void {
	const mobile = isMobileApp();
	// Debounce sync so pan/zoom (which fire requestFrame dozens of times/sec on
	// mobile) never trigger a full node scan mid-gesture.
	const SYNC_DEBOUNCE = mobile ? 250 : 100;
	const GESTURE_IDLE = mobile ? 260 : 140;

	let syncing = false;
	let interacting = false;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let gestureTimer: ReturnType<typeof setTimeout> | null = null;

	const runSync = () => {
		// Never scan/rewrite the DOM while the user is panning/zooming/dragging.
		if (syncing || interacting) return;
		syncing = true;
		try {
			syncCanvasMaskUI(canvas, canvasPath, app);
		} finally {
			syncing = false;
		}
	};

	const scheduleSync = () => {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			if (interacting) {
				scheduleSync();
				return;
			}
			runSync();
		}, SYNC_DEBOUNCE);
	};

	const refresh = () => scheduleSync();

	// A pointer/wheel gesture is in progress — suppress sync until it settles.
	const markInteracting = () => {
		interacting = true;
		if (gestureTimer) clearTimeout(gestureTimer);
		gestureTimer = setTimeout(() => {
			gestureTimer = null;
			interacting = false;
			scheduleSync();
		}, GESTURE_IDLE);
	};

	const wrapper = canvas.wrapperEl;
	const gestureOpts = { passive: true, capture: true } as AddEventListenerOptions;
	const onGesture = () => markInteracting();
	wrapper?.addEventListener("pointerdown", onGesture, gestureOpts);
	wrapper?.addEventListener("pointermove", onGesture, gestureOpts);
	wrapper?.addEventListener("pointerup", onGesture, gestureOpts);
	wrapper?.addEventListener("wheel", onGesture, gestureOpts);
	wrapper?.addEventListener("touchmove", onGesture, gestureOpts);

	// Initial application (deferred so it doesn't block the first paint).
	setTimeout(runSync, 0);

	const observer = new MutationObserver((records) => {
		if (interacting) return;
		const fromMask = records.some((r) => {
			const el = (r.target as Node).nodeType === Node.ELEMENT_NODE
				? (r.target as HTMLElement)
				: (r.target as Node).parentElement;
			return el?.closest?.(".mindvas-mask-ui, .mindvas-inline-mask-wrap") != null;
		});
		if (fromMask) return;
		scheduleSync();
	});
	observer.observe(canvas.wrapperEl, {
		subtree: true,
		childList: true,
	});

	const onVaultChange = app.vault.on("modify", (file) => {
		if (!(file instanceof TFile)) return;
		for (const node of canvas.nodes.values()) {
			if (resolveFilePath(node) === file.path) scheduleSync();
		}
	});

	// Boot: apply masks a few times right after load, then stop.
	let tick = 0;
	const bootMax = mobile ? 8 : 16;
	const bootInterval = window.setInterval(() => {
		if (!interacting) {
			runSync();
			scanCanvasEditingNodes(canvas.nodes.values());
		}
		if (++tick >= bootMax) window.clearInterval(bootInterval);
	}, mobile ? 500 : 400);

	const editScanInterval = window.setInterval(() => {
		if (interacting) return;
		scanCanvasEditingNodes(canvas.nodes.values());
	}, mobile ? 900 : 500);

	// Idle self-heal: only re-apply masks that went missing (e.g. after rerender).
	const maintainInterval = window.setInterval(() => {
		if (interacting) return;
		for (const node of canvas.nodes.values()) {
			if (!isMaskableCanvasNode(node)) continue;
			if (isTextCanvasNode(node) && (node.isEditing || isTextCardEditing(node))) continue;
			if (!isTextCanvasNode(node) && node.isEditing) continue;
			if (!node.nodeEl && !isTextCanvasNode(node)) continue;
			if (isTextCanvasNode(node) && !resolveTextCardHost(node)) continue;
			const source = getNodeTextSource(node);
			const needsMask = hasInlineMasks(source) || previewHasMaskTags(node.nodeEl);
			const hasOverlay = hasInlineMasks(source)
				? textCardMaskApplied(node, source)
				: textCardMaskApplied(node);
			if (needsMask && !hasOverlay) {
				syncOneNode(node, canvasPath, refresh, app);
				ensureNodeMaskWatch(node, canvasPath, app, refresh);
			}
		}
	}, mobile ? 1600 : 900);

	const cleanupSelection = trackCanvasSelection(canvas);

	return () => {
		window.clearInterval(bootInterval);
		window.clearInterval(editScanInterval);
		window.clearInterval(maintainInterval);
		if (debounceTimer) clearTimeout(debounceTimer);
		if (gestureTimer) clearTimeout(gestureTimer);
		wrapper?.removeEventListener("pointerdown", onGesture, gestureOpts);
		wrapper?.removeEventListener("pointermove", onGesture, gestureOpts);
		wrapper?.removeEventListener("pointerup", onGesture, gestureOpts);
		wrapper?.removeEventListener("wheel", onGesture, gestureOpts);
		wrapper?.removeEventListener("touchmove", onGesture, gestureOpts);
		observer.disconnect();
		app.vault.offref(onVaultChange);
		cleanupSelection();
		clearCanvasMaskUI(canvas);
	};
}
