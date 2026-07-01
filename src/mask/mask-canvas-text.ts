import type { CanvasNode } from "../types/canvas-internal";
import {
	hasInlineMasks,
	parseInlineMasks,
	countInlineMasks,
	maskItemKey,
	noteMaskItemKey,
} from "./mask-core";
import { refreshExistingMaskWraps, processMaskTagsInContainer } from "./mask-dom";
import { applyMasksFromSource, cleanupMaskTagRemnants } from "./mask-source";
import { getCanvasNodeMaskSource } from "./mask-canvas-preview";
import { isTextCanvasNode } from "./mask-canvas-node";
import { ensureCanvasMaskStylesForNode, restyleAllTapesUnder } from "./mask-canvas-styles";

function resolveCanvasFilePath(node: CanvasNode): string | null {
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

const OVERLAY_CLASS = "mindvas-mask-preview";
const NODE_MASK_CLASS = "mindvas-has-inline-mask";
const HIDDEN_ATTR = "data-mindvas-hidden";

const PREVIEW_SELECTORS = [
	".markdown-preview-view.markdown-rendered",
	".markdown-preview-view",
] as const;

/** Extra preview containers for file-embed cards (.md nodes). */
const EMBED_PREVIEW_SELECTORS = [
	".markdown-embed-content",
	".markdown-preview-sizer",
] as const;

const NATIVE_HIDE_SELECTORS = [
	":scope > .canvas-node-container",
	".markdown-preview-view",
	".markdown-embed-content",
	".canvas-node-content",
	"iframe",
] as const;

const overlayWatchers = new WeakMap<CanvasNode, MutationObserver>();

function isVisibleEl(el: HTMLElement): boolean {
	const style = getComputedStyle(el);
	if (style.display === "none" || style.visibility === "hidden") return false;
	if (parseFloat(style.opacity) === 0) return false;
	const rect = el.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0;
}

/** nodeEl + iframe body — Obsidian 1.12 / Advanced Canvas render preview inside iframe. */
export function getTextCardSearchRoots(node: CanvasNode): ParentNode[] {
	const roots: ParentNode[] = [];
	if (node.nodeEl) roots.push(node.nodeEl);
	const iframe = node.nodeEl?.querySelector("iframe");
	const body = iframe?.contentDocument?.body;
	if (body) roots.push(body);
	return roots;
}

export function hasVisibleTextCardPreview(node: CanvasNode): boolean {
	for (const root of getTextCardSearchRoots(node)) {
		for (const sel of PREVIEW_SELECTORS) {
			const el = root.querySelector<HTMLElement>(sel);
			if (el && isVisibleEl(el)) return true;
		}
	}
	return false;
}

function hasVisibleCodeMirror(node: CanvasNode): boolean {
	for (const root of getTextCardSearchRoots(node)) {
		const cm = root.querySelector<HTMLElement>(".cm-editor");
		if (cm && isVisibleEl(cm)) return true;
	}
	const active = document.activeElement;
	if (active && node.nodeEl?.contains(active) && active.closest(".cm-editor")) return true;
	return false;
}

export function isTextCardEditing(node: CanvasNode): boolean {
	if (!isTextCanvasNode(node)) return node.isEditing;
	if (!node.nodeEl) return node.isEditing;

	// Definite edit signals — must win over read-mode preview left in DOM.
	if (node.nodeEl.classList.contains("is-editing")) return true;
	if (hasVisibleCodeMirror(node)) return true;

	const active = document.activeElement;
	if (active && node.nodeEl.contains(active) && active.closest(".cm-editor")) return true;
	if (node.isEditing) return true;

	// Stuck is-editing flag after blur — preview back, no editor.
	if (hasVisibleTextCardPreview(node)) return false;

	return false;
}

/** True when the card shows rendered markdown (not the CodeMirror editor). */
export function isTextCardReadMode(node: CanvasNode): boolean {
	if (!isTextCanvasNode(node)) return !node.isEditing;
	return !isTextCardEditing(node);
}

/** Resolve stable host element for overlay (node.nodeEl or live .canvas-node in wrapper). */
export function resolveTextCardHost(node: CanvasNode): HTMLElement | null {
	if (node.nodeEl?.isConnected) return node.nodeEl;

	const canvas = node.canvas;
	if (node.nodeEl) {
		for (const el of Array.from(canvas.wrapperEl.querySelectorAll<HTMLElement>(".canvas-node"))) {
			if (el === node.nodeEl) return el;
		}
	}

	for (const el of Array.from(canvas.wrapperEl.querySelectorAll<HTMLElement>(".canvas-node"))) {
		if (el.dataset.id === node.id || el.dataset.nodeId === node.id) return el;
	}

	return node.nodeEl ?? null;
}

function maskKeyFor(node: CanvasNode, canvasPath: string): (index: number) => string {
	const path = resolveCanvasFilePath(node);
	if (path) return (i: number) => noteMaskItemKey(path, i);
	return (i: number) => maskItemKey(canvasPath, node.id, i);
}

/** Remove [mv|…] markdown link artifacts left in rendered preview. */
function cleanupMaskLinkArtifacts(root: ParentNode): void {
	for (const a of Array.from(root.querySelectorAll("a"))) {
		const t = (a.textContent ?? "").trim();
		if (/^mv\|(yellow|red|blue|green)$/i.test(t)) a.remove();
	}
}

function collectTextCardPreviewRoots(nodeEl: HTMLElement): HTMLElement[] {
	const roots = new Set<HTMLElement>();

	for (const sel of [...PREVIEW_SELECTORS, ...EMBED_PREVIEW_SELECTORS]) {
		nodeEl.querySelectorAll<HTMLElement>(sel).forEach((el) => roots.add(el));
	}

	const iframe = nodeEl.querySelector<HTMLIFrameElement>("iframe");
	const iframeBody = iframe?.contentDocument?.body;
	if (iframeBody) {
		for (const sel of [...PREVIEW_SELECTORS, ...EMBED_PREVIEW_SELECTORS]) {
			iframeBody.querySelectorAll<HTMLElement>(sel).forEach((el) => roots.add(el));
		}
	}

	const sizer = nodeEl.querySelector<HTMLElement>(".markdown-preview-sizer");
	if (sizer) roots.add(sizer);

	return Array.from(roots);
}

/** Remove legacy full-card overlay artifacts (breaks markdown + branch color). */
function cleanupStaleTextCardOverlay(host: HTMLElement): void {
	host.querySelector(`:scope > .${OVERLAY_CLASS}`)?.remove();
	host.classList.remove(NODE_MASK_CLASS);
	delete host.dataset.mindvasInlineMask;
	delete host.dataset.mindvasOverlayKey;
	for (const el of Array.from(host.querySelectorAll(".mindvas-native-hidden"))) {
		el.classList.remove("mindvas-native-hidden");
	}
	showNativeTextCardContent(host);
}

function countPreviewMaskWraps(node: CanvasNode): number {
	const host = resolveTextCardHost(node);
	if (!host) return 0;
	let max = 0;
	for (const root of collectTextCardPreviewRoots(host)) {
		max = Math.max(max, root.querySelectorAll(".mindvas-inline-mask-wrap").length);
	}
	return max;
}

/** Patch tape into live markdown preview — keeps headings/lists intact. */
function applyTextCardPreviewMasks(
	node: CanvasNode,
	content: string,
	canvasPath: string
): boolean {
	const host = resolveTextCardHost(node);
	if (!host) return false;

	ensureCanvasMaskStylesForNode(host);
	const keyFor = maskKeyFor(node, canvasPath);
	const expected = countInlineMasks(content);
	const segments = parseInlineMasks(content);
	let applied = 0;

	for (const root of collectTextCardPreviewRoots(host)) {
		if (refreshExistingMaskWraps(root, content, keyFor)) {
			applied = expected;
		} else {
			applied = Math.max(applied, applyMasksFromSource(root, content, segments, keyFor));
			processMaskTagsInContainer(root, keyFor);
		}
		cleanupMaskTagRemnants(root);
		cleanupMaskLinkArtifacts(root);
	}

	restyleAllTapesUnder(host);
	for (const root of collectTextCardPreviewRoots(host)) {
		restyleAllTapesUnder(root);
	}

	return applied >= expected && countPreviewMaskWraps(node) >= expected;
}

export function hideNativeTextCardContent(nodeEl: HTMLElement): void {
	for (const sel of NATIVE_HIDE_SELECTORS) {
		for (const el of Array.from(nodeEl.querySelectorAll(sel))) {
			if (!(el instanceof HTMLElement)) continue;
			if (el.classList.contains(OVERLAY_CLASS) || el.closest(`.${OVERLAY_CLASS}`)) continue;
			el.setAttribute(HIDDEN_ATTR, "1");
			el.style.setProperty("display", "none", "important");
			el.style.setProperty("visibility", "hidden", "important");
			el.style.setProperty("pointer-events", "none", "important");
		}
	}

	for (const iframe of Array.from(nodeEl.querySelectorAll("iframe"))) {
		try {
			const doc = iframe.contentDocument;
			if (!doc) continue;
			for (const sel of [".markdown-preview-view", ".markdown-embed-content", ".cm-editor"]) {
				doc.querySelectorAll(sel).forEach((inner) => {
					if (!(inner instanceof HTMLElement)) return;
					inner.setAttribute(HIDDEN_ATTR, "1");
					inner.style.setProperty("display", "none", "important");
					inner.style.setProperty("visibility", "hidden", "important");
					inner.style.setProperty("pointer-events", "none", "important");
				});
			}
		} catch {
			// cross-origin iframe — hide whole frame
			iframe.setAttribute(HIDDEN_ATTR, "1");
			iframe.style.setProperty("opacity", "0", "important");
			iframe.style.setProperty("pointer-events", "none", "important");
		}
	}
}

export function showNativeTextCardContent(nodeEl: HTMLElement): void {
	for (const el of Array.from(nodeEl.querySelectorAll(`[${HIDDEN_ATTR}]`))) {
		if (!(el instanceof HTMLElement)) continue;
		el.removeAttribute(HIDDEN_ATTR);
		el.style.removeProperty("display");
		el.style.removeProperty("visibility");
		el.style.removeProperty("pointer-events");
		el.style.removeProperty("opacity");
	}

	for (const iframe of Array.from(nodeEl.querySelectorAll("iframe"))) {
		try {
			const doc = iframe.contentDocument;
			if (!doc) continue;
			doc.querySelectorAll(`[${HIDDEN_ATTR}]`).forEach((inner) => {
				if (!(inner instanceof HTMLElement)) return;
				inner.removeAttribute(HIDDEN_ATTR);
				inner.style.removeProperty("display");
				inner.style.removeProperty("visibility");
				inner.style.removeProperty("pointer-events");
			});
		} catch {
			iframe.removeAttribute(HIDDEN_ATTR);
			iframe.style.removeProperty("opacity");
			iframe.style.removeProperty("pointer-events");
		}
	}
}

export function clearTextCardOverlay(node: CanvasNode): void {
	const host = resolveTextCardHost(node);
	if (!host) return;
	overlayWatchers.get(node)?.disconnect();
	overlayWatchers.delete(node);
	cleanupStaleTextCardOverlay(host);
	delete host.dataset.mindvasPreviewMasked;
}

export function textCardMaskApplied(node: CanvasNode, content?: string): boolean {
	const expected = content ? countInlineMasks(content) : 1;
	return countPreviewMaskWraps(node) >= expected;
}

/** @deprecated Use textCardMaskApplied — preview-only, no full-card overlay. */
export function textCardOverlayApplied(node: CanvasNode, content?: string): boolean {
	return textCardMaskApplied(node, content);
}

function ensurePreviewMaskWatcher(node: CanvasNode, content: string, canvasPath: string): void {
	const host = resolveTextCardHost(node);
	if (!host || overlayWatchers.has(node)) return;

	const observer = new MutationObserver(() => {
		if (!isTextCardReadMode(node)) return;
		if (!hasInlineMasks(content)) return;
		if (!resolveTextCardHost(node)?.isConnected) return;
		if (textCardMaskApplied(node, content)) return;
		applyTextCardPreviewMasks(node, content, canvasPath);
	});

	observer.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });
	overlayWatchers.set(node, observer);
}

/** @deprecated Full-card overlay breaks markdown/card theme — kept for cleanup only. */
export function ensureTextCardOverlay(
	node: CanvasNode,
	content: string,
	_canvasPath: string
): void {
	clearTextCardOverlay(node);
}

export function syncTextCardReadMask(node: CanvasNode, canvasPath: string): void {
	if (!isTextCanvasNode(node)) return;
	if (!isTextCardReadMode(node)) {
		clearTextCardOverlay(node);
		return;
	}
	const content = getCanvasNodeMaskSource(node);
	if (!hasInlineMasks(content)) {
		clearTextCardOverlay(node);
		return;
	}

	const host = resolveTextCardHost(node);
	if (host) cleanupStaleTextCardOverlay(host);

	// In-preview tape only — same markdown/card chrome as other cards.
	applyTextCardPreviewMasks(node, content, canvasPath);
	if (host) {
		host.dataset.mindvasPreviewMasked = "1";
		ensurePreviewMaskWatcher(node, content, canvasPath);
	}
}

/**
 * In-preview tape for any maskable card (text or file embed).
 * Keeps native markdown + branch color — no plain-text overlay.
 */
export function applyCanvasNodeInPreviewMasks(
	node: CanvasNode,
	content: string,
	canvasPath: string
): boolean {
	const host = resolveTextCardHost(node);
	if (!host) return false;
	cleanupStaleTextCardOverlay(host);
	const ok = applyTextCardPreviewMasks(node, content, canvasPath);
	host.dataset.mindvasPreviewMasked = "1";
	return ok;
}

/** Scan live DOM — re-sync in-preview masks without replacing card content. */
export function syncAllTextCardMasksOnCanvas(canvasPath: string, nodes: Iterable<CanvasNode>): void {
	for (const node of nodes) {
		if (!isTextCanvasNode(node)) continue;
		const content = getCanvasNodeMaskSource(node);
		if (!hasInlineMasks(content)) continue;
		if (node.isEditing || isTextCardEditing(node)) continue;
		syncTextCardReadMask(node, canvasPath);
	}
}
