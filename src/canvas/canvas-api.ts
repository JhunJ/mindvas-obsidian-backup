import { App, ItemView } from "obsidian";
import type {
	Canvas,
	CanvasView,
	CanvasNode,
	CanvasEdge,
	NodeSide,
} from "../types/canvas-internal";
import { isMobileApp } from "../ui/mobile-utils";

interface EdgeIndex {
	/** Edges pointing TO a node (node is target) */
	incoming: Map<string, CanvasEdge[]>;
	/** Edges pointing FROM a node (node is source) */
	outgoing: Map<string, CanvasEdge[]>;
}

/**
 * Generate a 16-character hex ID for canvas elements.
 */
export function genId(): string {
	return Array.from({ length: 16 }, () =>
		Math.floor(Math.random() * 16).toString(16)
	).join("");
}

/**
 * Find the CanvasNode whose nodeEl contains the event target.
 */
export function findNodeFromEvent(canvas: Canvas, e: PointerEvent | MouseEvent): CanvasNode | null {
	const target = e.target as HTMLElement;
	if (!target) return null;
	for (const node of canvas.nodes.values()) {
		if (node.nodeEl?.contains(target)) return node;
	}
	return null;
}

/** Minimum pointer movement before treating a gesture as a node drag (not a pan). */
export const NODE_DRAG_THRESHOLD_PX = 8;

/** True when Obsidian canvas is in read-only / presentation mode. */
export function isCanvasReadonly(canvas: Canvas): boolean {
	return canvas.readonly === true;
}

/** True when the pointer target is a canvas node (not empty canvas background). */
export function isNodePointerTarget(canvas: Canvas, e: PointerEvent | MouseEvent): boolean {
	return findNodeFromEvent(canvas, e) !== null;
}

/**
 * True when Mindvas should treat this pointer gesture as a node drag.
 * In read mode the user is panning the viewport — never hijack as node drag.
 */
export function isNodeDragGesture(canvas: Canvas, e: PointerEvent | MouseEvent): boolean {
	if (isCanvasReadonly(canvas)) return false;
	return isNodePointerTarget(canvas, e);
}

/**
 * Typed wrapper around Obsidian's undocumented Canvas runtime API.
 * Maintains a lazily-built edge index for O(1) parent/child lookups.
 */
export class CanvasAPI {
	private edgeIndex: EdgeIndex | null = null;
	private indexedCanvas: Canvas | null = null;
	private indexedEdgeIds: Set<string> | null = null;

	constructor(private app: App) {}

	/**
	 * Get or rebuild the edge index for the given canvas.
	 * Rebuilds if canvas changed or edge count changed (structural mutation).
	 */
	private getEdgeIndex(canvas: Canvas): EdgeIndex {
		if (
			this.edgeIndex &&
			this.indexedCanvas === canvas &&
			this.edgeIdsMatch(canvas)
		) {
			return this.edgeIndex;
		}

		const incoming = new Map<string, CanvasEdge[]>();
		const outgoing = new Map<string, CanvasEdge[]>();

		for (const edge of canvas.edges.values()) {
			const fromId = edge.from.node.id;
			const toId = edge.to.node.id;

			let out = outgoing.get(fromId);
			if (!out) { out = []; outgoing.set(fromId, out); }
			out.push(edge);

			let inc = incoming.get(toId);
			if (!inc) { inc = []; incoming.set(toId, inc); }
			inc.push(edge);
		}

		this.edgeIndex = { incoming, outgoing };
		this.indexedCanvas = canvas;
		this.indexedEdgeIds = new Set(canvas.edges.keys());
		return this.edgeIndex;
	}

	/**
	 * Check whether the cached edge ID set still matches the live canvas.
	 */
	private edgeIdsMatch(canvas: Canvas): boolean {
		if (!this.indexedEdgeIds || canvas.edges.size !== this.indexedEdgeIds.size) return false;
		for (const id of canvas.edges.keys()) {
			if (!this.indexedEdgeIds.has(id)) return false;
		}
		return true;
	}

	/**
	 * Invalidate the edge index (call after adding/removing edges).
	 */
	invalidateEdgeIndex(): void {
		this.edgeIndex = null;
	}

	/**
	 * Get the active canvas if a canvas view is currently focused.
	 */
	getActiveCanvas(): Canvas | null {
		const view = this.app.workspace.getActiveViewOfType(ItemView);
		if (!view || view.getViewType() !== "canvas") return null;

		return (view as unknown as CanvasView).canvas ?? null;
	}

	/**
	 * Get canvas from any open canvas leaf (first found).
	 */
	getAnyCanvas(): Canvas | null {
		const leaves = this.app.workspace.getLeavesOfType("canvas");
		if (leaves.length === 0) return null;

		const view = leaves[0].view as unknown as CanvasView;
		return view?.canvas ?? null;
	}

	/**
	 * Get a selected text/file node (first match if several selected).
	 */
	getSelectedNode(canvas: Canvas): CanvasNode | null {
		for (const item of canvas.selection) {
			if (!item || !("nodeEl" in item)) continue;
			const node = item as CanvasNode;
			if (node.type === "text" || node.type === "file") return node;
		}
		return null;
	}

	/**
	 * Create a text node at a given position.
	 */
	createTextNode(
		canvas: Canvas,
		x: number,
		y: number,
		text: string = "",
		width: number = 260,
		height: number = 60
	): CanvasNode {
		const node = canvas.createTextNode({
			pos: { x, y },
			size: { width, height },
			text,
			focus: false,
			save: false,
		});
		return node;
	}

	/**
	 * Create a file/image node at a given position.
	 */
	createFileNode(
		canvas: Canvas,
		filePath: string,
		x: number,
		y: number,
		width: number = 400,
		height: number = 300
	): CanvasNode | null {
		const c = canvas as Canvas & {
			createFileNode?: (opts: {
				pos: { x: number; y: number };
				size?: { width: number; height: number };
				file: string;
				focus?: boolean;
				save?: boolean;
			}) => CanvasNode;
		};
		if (typeof c.createFileNode !== "function") return null;
		return c.createFileNode({
			pos: { x, y },
			size: { width, height },
			file: filePath,
			focus: false,
			save: true,
		});
	}

	/**
	 * Canvas coordinate at the center of the visible viewport.
	 * Used to drop new nodes where the user is currently looking.
	 */
	getViewportCenter(canvas: Canvas): { x: number; y: number } {
		const c = canvas as Canvas & { tx?: number; ty?: number; zoom?: number };
		const rect = canvas.wrapperEl?.getBoundingClientRect();
		const zoom = c.zoom || 1;
		const tx = c.tx ?? 0;
		const ty = c.ty ?? 0;
		const w = rect?.width ?? 800;
		const h = rect?.height ?? 600;
		return {
			x: (w / 2 - tx) / zoom,
			y: (h / 2 - ty) / zoom,
		};
	}

	/**
	 * Create an edge between two nodes using canvas.importData.
	 */
	createEdge(
		canvas: Canvas,
		fromNode: CanvasNode,
		toNode: CanvasNode,
		fromSide: NodeSide = "right",
		toSide: NodeSide = "left",
		color?: string
	): void {
		const id = genId();

		canvas.importData({
			edges: [
				{
					id,
					fromNode: fromNode.id,
					fromSide,
					fromEnd: "none",
					toNode: toNode.id,
					toSide,
					toEnd: "arrow",
					...(color ? { color } : {}),
				},
			],
			nodes: [],
		});
		this.invalidateEdgeIndex();
	}

	/**
	 * Remove a node and all its connected edges.
	 */
	removeNode(canvas: Canvas, node: CanvasNode): void {
		// Find and remove connected edges
		const connectedEdges = this.getConnectedEdges(canvas, node);
		for (const edge of connectedEdges) {
			canvas.removeEdge(edge);
		}
		canvas.removeNode(node);
		this.invalidateEdgeIndex();
	}

	/**
	 * Get all edges connected to a node (incoming + outgoing).
	 */
	getConnectedEdges(canvas: Canvas, node: CanvasNode): CanvasEdge[] {
		const idx = this.getEdgeIndex(canvas);
		const inc = idx.incoming.get(node.id) ?? [];
		const out = idx.outgoing.get(node.id) ?? [];
		return [...inc, ...out];
	}

	/**
	 * Get parent node (the node that has an edge pointing TO this node).
	 */
	getParentNode(canvas: Canvas, node: CanvasNode): CanvasNode | null {
		const idx = this.getEdgeIndex(canvas);
		const inc = idx.incoming.get(node.id);
		return inc && inc.length > 0 ? inc[0].from.node : null;
	}

	/**
	 * Get child nodes (nodes that this node has edges pointing TO).
	 */
	getChildNodes(canvas: Canvas, node: CanvasNode): CanvasNode[] {
		const idx = this.getEdgeIndex(canvas);
		const out = idx.outgoing.get(node.id) ?? [];
		const children = out.map(e => e.to.node);
		// Sort by y position (top to bottom) for consistent sibling order
		children.sort((a, b) => a.y - b.y);
		return children;
	}

	/**
	 * Get outgoing edges from a node (for BFS traversal).
	 */
	getOutgoingEdges(canvas: Canvas, nodeId: string): CanvasEdge[] {
		const idx = this.getEdgeIndex(canvas);
		return idx.outgoing.get(nodeId) ?? [];
	}

	/**
	 * Get sibling nodes (other children of the same parent).
	 */
	getSiblingNodes(canvas: Canvas, node: CanvasNode): CanvasNode[] {
		const parent = this.getParentNode(canvas, node);
		if (!parent) return [];

		return this.getChildNodes(canvas, parent).filter(
			(n) => n.id !== node.id
		);
	}

	/**
	 * Select a node and zoom to it with padding.
	 */
	selectAndZoom(canvas: Canvas, node: CanvasNode, zoomPadding: number): void {
		canvas.selectOnly(node);
		// Mobile: never auto-zoom — user keeps their pan/zoom while editing.
		if (isMobileApp()) return;
		if (zoomPadding > 0) {
			const cx = node.x + node.width / 2;
			const cy = node.y + node.height / 2;
			canvas.zoomToBbox({
				minX: cx - zoomPadding,
				minY: cy - zoomPadding,
				maxX: cx + zoomPadding,
				maxY: cy + zoomPadding,
			});
		} else {
			canvas.zoomToSelection();
		}
	}

	selectAndEdit(canvas: Canvas, node: CanvasNode, zoomPadding: number = 0): void {
		this.selectAndZoom(canvas, node, zoomPadding);
		setTimeout(() => {
			node.startEditing();
		}, 50);
	}

}
