import { ItemView, WorkspaceLeaf, setIcon, TFile } from "obsidian";
import type { App } from "obsidian";
import type { Canvas, CanvasNode, CanvasView as CanvasViewType } from "../types/canvas-internal";
import {
	parseInlineMasks,
	hasInlineMasks,
	maskItemKey,
	noteMaskItemKey,
	MASK_COLORS,
	type MaskColor,
} from "../mask/mask-core";
import { resolveCanvasFilePath } from "../mask/mask-canvas";
import { getCanvasNodeMaskSource } from "../mask/mask-canvas-preview";
import { markdownToPlainDisplay } from "../mask/mask-source";
import { getNodeTitle } from "./outline-view";
import { isMobileApp } from "./mobile-utils";

export const MASK_PANEL_VIEW_TYPE = "mindvas-mask-panel";

const COLOR_ORDER: MaskColor[] = ["yellow", "red", "blue", "green"];

const COLOR_HEX: Record<MaskColor, string> = {
	yellow: "#e6b800",
	red: "#e04b4b",
	blue: "#4b7be0",
	green: "#3fae6b",
};

interface MaskEntry {
	node: CanvasNode;
	color: MaskColor;
	display: string;
	nodeTitle: string;
	notePath: string | null;
}

/**
 * Sidebar panel listing every mask on the active canvas grouped by color.
 * Clicking an entry selects and (on desktop) zooms to its node.
 */
export class MaskPanelView extends ItemView {
	private lastCanvas: Canvas | null = null;
	private activeColors = new Set<MaskColor>(COLOR_ORDER);
	private listEl: HTMLElement | null = null;
	private filterBarEl: HTMLElement | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private getActiveCanvas: () => Canvas | null
	) {
		super(leaf);
	}

	getViewType(): string {
		return MASK_PANEL_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "마스킹 목록";
	}

	getIcon(): string {
		return "bandage";
	}

	onOpen(): Promise<void> {
		this.contentEl.addClass("mindvas-mask-panel");

		const navHeader = this.containerEl.createDiv({ cls: "nav-header" });
		this.containerEl.insertBefore(navHeader, this.contentEl);
		const navButtons = navHeader.createDiv({ cls: "nav-buttons-container" });

		const refreshBtn = navButtons.createDiv({
			cls: "clickable-icon nav-action-button",
			attr: { "aria-label": "새로고침" },
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.addEventListener("click", () => this.refreshFromActive());

		this.filterBarEl = this.contentEl.createDiv({ cls: "mindvas-mask-filter-bar" });
		this.listEl = this.contentEl.createDiv({ cls: "mindvas-mask-list" });

		this.renderFilterBar();
		this.refreshFromActive();
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.contentEl.empty();
		return Promise.resolve();
	}

	private renderFilterBar(): void {
		if (!this.filterBarEl) return;
		this.filterBarEl.empty();
		for (const color of COLOR_ORDER) {
			const active = this.activeColors.has(color);
			const chip = this.filterBarEl.createDiv({
				cls: "mindvas-mask-chip" + (active ? " is-active" : ""),
			});
			const dot = chip.createSpan({ cls: "mindvas-mask-dot" });
			dot.style.backgroundColor = COLOR_HEX[color];
			chip.createSpan({ text: MASK_COLORS[color].label });
			chip.addEventListener("click", () => {
				if (this.activeColors.has(color)) this.activeColors.delete(color);
				else this.activeColors.add(color);
				this.renderFilterBar();
				void this.render();
			});
		}
	}

	refreshFromActive(): void {
		this.lastCanvas = this.getActiveCanvas();
		void this.render();
	}

	private async collect(canvas: Canvas): Promise<MaskEntry[]> {
		const entries: MaskEntry[] = [];
		for (const node of canvas.nodes.values()) {
			let source = getCanvasNodeMaskSource(node);
			const filePath = resolveCanvasFilePath(node);
			if (!hasInlineMasks(source) && filePath) {
				const file = this.app.vault.getAbstractFileByPath(filePath);
				if (file instanceof TFile) {
					try {
						source = await this.app.vault.cachedRead(file);
					} catch {
						// ignore unreadable files
					}
				}
			}
			if (!hasInlineMasks(source)) continue;

			const nodeTitle = getNodeTitle(this.app, canvas, node);
			for (const seg of parseInlineMasks(source)) {
				if (seg.type !== "mask") continue;
				entries.push({
					node,
					color: seg.color ?? "yellow",
					display: markdownToPlainDisplay(seg.content) || "(빈 항목)",
					nodeTitle,
					notePath: filePath,
				});
			}
		}
		return entries;
	}

	private async render(): Promise<void> {
		const list = this.listEl;
		if (!list) return;
		list.empty();

		const canvas = this.lastCanvas;
		if (!canvas) {
			list.createDiv({ cls: "mindvas-mask-empty", text: "캔버스를 여세요" });
			return;
		}

		const entries = await this.collect(canvas);
		// The active canvas may have changed while awaiting file reads.
		if (this.lastCanvas !== canvas) return;

		if (entries.length === 0) {
			list.createDiv({ cls: "mindvas-mask-empty", text: "마스킹이 없습니다" });
			return;
		}

		for (const color of COLOR_ORDER) {
			if (!this.activeColors.has(color)) continue;
			const group = entries.filter((e) => e.color === color);
			if (group.length === 0) continue;

			const section = list.createDiv({ cls: "mindvas-mask-group" });
			const header = section.createDiv({ cls: "mindvas-mask-group-header" });
			const dot = header.createSpan({ cls: "mindvas-mask-dot" });
			dot.style.backgroundColor = COLOR_HEX[color];
			header.createSpan({ cls: "mindvas-mask-group-title", text: MASK_COLORS[color].label });
			header.createSpan({ cls: "mindvas-mask-group-count", text: `${group.length}` });

			for (const entry of group) {
				this.renderEntry(section, entry, canvas);
			}
		}
	}

	private renderEntry(container: HTMLElement, entry: MaskEntry, canvas: Canvas): void {
		const item = container.createDiv({ cls: "mindvas-mask-item is-clickable" });
		item.style.borderLeftColor = COLOR_HEX[entry.color];

		item.createDiv({ cls: "mindvas-mask-item-text", text: entry.display });
		const meta = item.createDiv({ cls: "mindvas-mask-item-meta" });
		setIcon(meta.createSpan({ cls: "mindvas-mask-item-icon" }), entry.notePath ? "file-text" : "sticky-note");
		meta.createSpan({ text: entry.nodeTitle });

		item.addEventListener("click", () => this.navigateTo(canvas, entry.node));
	}

	private navigateTo(canvas: Canvas, node: CanvasNode): void {
		const leaf = this.app.workspace
			.getLeavesOfType("canvas")
			.find((l) => (l.view as unknown as CanvasViewType)?.canvas === canvas);
		if (leaf) this.app.workspace.setActiveLeaf(leaf, { focus: true });

		try {
			canvas.selectOnly(node);
		} catch {
			return;
		}

		if (!isMobileApp()) {
			const pad = 60;
			const cx = node.x + node.width / 2;
			const cy = node.y + node.height / 2;
			canvas.zoomToBbox({
				minX: cx - pad,
				minY: cy - pad,
				maxX: cx + pad,
				maxY: cy + pad,
			});
		}
	}
}
