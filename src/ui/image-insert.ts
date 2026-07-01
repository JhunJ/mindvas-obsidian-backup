import { Notice } from "obsidian";
import type { App } from "obsidian";
import type { Canvas } from "../types/canvas-internal";
import type { CanvasAPI } from "../canvas/canvas-api";

type AttachmentApp = App & {
	fileManager: {
		getAvailablePathForAttachment?: (fileName: string, sourcePath?: string) => Promise<string>;
	};
};

/** Save picked image bytes into the vault's attachment folder, return its path. */
async function saveImageToVault(
	app: App,
	file: File,
	canvasPath: string
): Promise<string | null> {
	const buf = await file.arrayBuffer();
	const safeName = file.name && file.name.trim() ? file.name : `pasted-image-${Date.now()}.png`;

	const fm = (app as AttachmentApp).fileManager;
	let targetPath: string;
	if (typeof fm.getAvailablePathForAttachment === "function") {
		targetPath = await fm.getAvailablePathForAttachment(safeName, canvasPath);
	} else {
		targetPath = safeName;
	}

	try {
		const created = await app.vault.createBinary(targetPath, buf);
		return created.path;
	} catch (err) {
		console.error("Mindvas: failed to save image to vault", err);
		return null;
	}
}

/** Rough intrinsic size for the image so the node isn't distorted. */
function readImageSize(file: File): Promise<{ width: number; height: number }> {
	return new Promise((resolve) => {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(url);
			resolve({ width: img.naturalWidth || 400, height: img.naturalHeight || 300 });
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			resolve({ width: 400, height: 300 });
		};
		img.src = url;
	});
}

/** Fit an image into a sensible canvas node size (cap the longest edge). */
function fitNodeSize(w: number, h: number): { width: number; height: number } {
	const MAX = 480;
	if (w <= MAX && h <= MAX) return { width: Math.max(w, 80), height: Math.max(h, 80) };
	const scale = MAX / Math.max(w, h);
	return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

/**
 * Prompt for an image (works on desktop and mobile), store it in the vault,
 * then drop a file node at the center of the current viewport.
 */
export function insertImageToCanvas(
	app: App,
	canvas: Canvas,
	canvasApi: CanvasAPI,
	canvasPath: string
): void {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = "image/*";
	input.style.display = "none";

	input.addEventListener(
		"change",
		async () => {
			const file = input.files?.[0];
			input.remove();
			if (!file) return;

			const notice = new Notice("이미지 삽입 중…", 0);
			try {
				const [{ width, height }, savedPath] = await Promise.all([
					readImageSize(file),
					saveImageToVault(app, file, canvasPath),
				]);
				if (!savedPath) {
					new Notice("이미지 저장 실패");
					return;
				}

				const size = fitNodeSize(width, height);
				const center = canvasApi.getViewportCenter(canvas);
				const node = canvasApi.createFileNode(
					canvas,
					savedPath,
					center.x - size.width / 2,
					center.y - size.height / 2,
					size.width,
					size.height
				);

				if (!node) {
					new Notice("이 캔버스에서 이미지 노드를 만들 수 없습니다");
					return;
				}
				canvas.requestSave();
				try {
					canvas.selectOnly(node);
				} catch {
					// selection is best-effort
				}
			} finally {
				notice.hide();
			}
		},
		{ once: true }
	);

	document.body.appendChild(input);
	input.click();
}
