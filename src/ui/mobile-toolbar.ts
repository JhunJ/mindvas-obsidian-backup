import { Menu, Plugin, setIcon } from "obsidian";
import type { Canvas } from "../types/canvas-internal";
import { isMobileApp, isPhone } from "./mobile-utils";

interface ToolbarAction {
	id: string;
	icon: string;
	label: string;
	commandId: string;
}

const TOOLBAR_ACTIONS: ToolbarAction[] = [
	{ id: "edit", icon: "pencil", label: "Edit node", commandId: "mindvas:mindmap-edit-node" },
	{ id: "child", icon: "plus", label: "Add child", commandId: "mindvas:mindmap-add-child" },
	{ id: "sibling", icon: "corner-down-left", label: "Add sibling", commandId: "mindvas:mindmap-add-sibling" },
	{ id: "fold", icon: "chevrons-down-up", label: "Toggle branch fold", commandId: "mindvas:mindmap-toggle-branch-fold" },
	{ id: "nav-left", icon: "arrow-left", label: "Navigate left", commandId: "mindvas:mindmap-nav-left" },
	{ id: "nav-up", icon: "arrow-up", label: "Navigate up", commandId: "mindvas:mindmap-nav-prev-sibling" },
	{ id: "nav-down", icon: "arrow-down", label: "Navigate down", commandId: "mindvas:mindmap-nav-next-sibling" },
	{ id: "nav-right", icon: "arrow-right", label: "Navigate right", commandId: "mindvas:mindmap-nav-right" },
	{ id: "relayout", icon: "refresh-cw", label: "Re-layout", commandId: "mindvas:mindmap-relayout" },
	{ id: "outline", icon: "list-tree", label: "Open outline", commandId: "mindvas:mindmap-open-outline" },
];

/**
 * Mobile canvas controls — single FAB + popup menu on phones to avoid
 * overlapping Obsidian's native canvas bottom toolbar.
 */
export class MobileToolbar {
	private fabEl: HTMLElement | null = null;
	private visible = false;

	constructor(
		private plugin: Plugin,
		private isMindmapActive: (canvas: Canvas) => boolean
	) {}

	mount(canvas: Canvas): void {
		if (!isMobileApp() || !isPhone()) return;
		this.unmount();

		const wrapper = canvas.wrapperEl;
		if (!wrapper) return;

		const fab = document.createElement("button");
		fab.addClass("mindvas-mobile-action-fab", "clickable-icon");
		fab.setAttribute("type", "button");
		fab.setAttribute("aria-label", "Mindvas actions");

		this.plugin.registerDomEvent(fab, "click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.openActionMenu(fab, canvas);
		});

		wrapper.appendChild(fab);
		this.fabEl = fab;
		this.updateFab(canvas);
		// Always visible: image insert & masking are useful outside mindmap mode too.
		this.setVisible(true);
	}

	private openActionMenu(anchor: HTMLElement, canvas: Canvas): void {
		const menu = new Menu();
		const { commands } = this.plugin.app as unknown as {
			commands: { executeCommandById: (id: string) => boolean };
		};

		menu.addItem((item) => {
			const active = this.isMindmapActive(canvas);
			item.setTitle(active ? "Disable mindmap mode" : "Enable mindmap mode")
				.setIcon(active ? "network" : "layout-dashboard")
				.onClick(() => commands?.executeCommandById?.("mindvas:mindmap-toggle-mode"));
		});

		// Always available — image insert + masking, regardless of mindmap mode.
		menu.addItem((item) => {
			item.setTitle("이미지 삽입")
				.setIcon("image")
				.onClick(() => commands?.executeCommandById?.("mindvas:insert-image"));
		});
		menu.addItem((item) => {
			item.setTitle("가리기")
				.setIcon("bandage")
				.onClick(() => commands?.executeCommandById?.("mindvas:mindmap-toggle-node-mask"));
		});
		menu.addItem((item) => {
			item.setTitle("마스킹 목록")
				.setIcon("list")
				.onClick(() => commands?.executeCommandById?.("mindvas:open-mask-panel"));
		});

		if (this.isMindmapActive(canvas)) {
			menu.addSeparator();
			for (const action of TOOLBAR_ACTIONS) {
				menu.addItem((item) => {
					item.setTitle(action.label)
						.setIcon(action.icon)
						.onClick(() => commands?.executeCommandById?.(action.commandId));
				});
			}
		}

		menu.showAtPosition({
			x: anchor.getBoundingClientRect().right,
			y: anchor.getBoundingClientRect().top,
			overlap: true,
			left: true,
		});
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.fabEl?.toggleClass("is-hidden", !visible);
	}

	updateFab(canvas: Canvas): void {
		if (!this.fabEl) return;
		const active = this.isMindmapActive(canvas);
		this.fabEl.empty();
		setIcon(this.fabEl, active ? "network" : "layout-dashboard");
		this.fabEl.toggleClass("is-active", active);
		this.fabEl.setAttribute("aria-label", active ? "Mindvas (active)" : "Mindvas");
	}

	unmount(): void {
		this.fabEl?.remove();
		this.fabEl = null;
		this.visible = false;
	}
}
