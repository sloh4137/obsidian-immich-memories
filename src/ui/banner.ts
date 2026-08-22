import { App, MarkdownView, Plugin, TFile } from "obsidian";
import { AssetFileCache } from "../cache";
import { ImmichPhoto, ImmichSettings } from "../types";
import { ImmichPhotoModal } from "./photo-modal";

type FrontmatterValue = string | string[] | number | boolean | Date | null | undefined;
type FrontmatterRecord = Record<string, FrontmatterValue>;

export const BANNER_CLASS = "immich-banner";
const READING_HOST_SELECTOR = ".markdown-preview-sizer";
const EDITOR_HOST_SELECTOR = ".cm-sizer";

function isDateValue(v: unknown): v is Date {
	return v instanceof Date;
}

function getFileFrontmatter(app: App, file: TFile): FrontmatterRecord | null {
	try {
		const cache = app.metadataCache.getFileCache(file);
		return (cache?.frontmatter as FrontmatterRecord) ?? null;
	} catch {
		return null;
	}
}

function extractFrontmatterString(
	fm: FrontmatterRecord | null,
	fieldName: string
): string | null {
	if (!fm) return null;

	const coerce = (val: unknown): string | null => {
		if (val == null) return null;
		if (typeof val === "string") return val;
		if (isDateValue(val)) return val.toISOString().slice(0, 10);
		if (typeof val === "number" || typeof val === "boolean") return String(val);
		return null;
	};

	const direct = fm[fieldName] as unknown;
	const directCoerced = coerce(direct);
	if (directCoerced) return directCoerced;

	if (Array.isArray(direct) && direct.length > 0) {
		for (const item of direct) {
			const c = coerce(item);
			if (c) return c;
		}
	}

	const lower = fieldName.toLowerCase();
	for (const k of Object.keys(fm)) {
		if (k.toLowerCase() !== lower) continue;
		const v = fm[k] as unknown;
		const coerced = coerce(v);
		if (coerced) return coerced;
		if (Array.isArray(v)) {
			for (const item of v) {
				const c = coerce(item);
				if (c) return c;
			}
		}
	}
	return null;
}

function normalizeCssClasses(raw: FrontmatterValue | undefined): string[] {
	if (!raw) return [];
	if (typeof raw === "string") {
		return raw
			.split(/[\s,]+/)
			.map((s) => s.trim())
			.filter(Boolean);
	}
	if (Array.isArray(raw)) {
		const out: string[] = [];
		for (const entry of raw) {
			if (typeof entry !== "string") continue;
			const parts = entry
				.split(/[\s,]+/)
				.map((s) => s.trim())
				.filter(Boolean);
			out.push(...parts);
		}
		return out;
	}
	return [];
}

function frontmatterHasImmichBanner(fm: FrontmatterRecord | null): boolean {
	if (!fm) return false;
	const rawValue = fm["cssclasses"] ?? fm["cssclass"];
	const classes = normalizeCssClasses(rawValue);
	return classes.includes("immichBanner");
}

function getMarkdownViews(app: App): MarkdownView[] {
	const views: MarkdownView[] = [];
	app.workspace.iterateAllLeaves((leaf) => {
		const view = leaf.view;
		if (view instanceof MarkdownView) {
			views.push(view);
		}
	});
	return views;
}

function removeAllBanners(view: MarkdownView): void {
	view.containerEl.querySelectorAll(`.${BANNER_CLASS}`).forEach((el) => el.remove());
}

function removeBannersExcept(view: MarkdownView, keepHost: HTMLElement): void {
	view.containerEl.querySelectorAll(`.${BANNER_CLASS}`).forEach((el) => {
		if (el.parentElement !== keepHost) el.remove();
	});
}

function bannerSignature(path: string, dateStr: string, timeZone: string): string {
	return `${path}\n${dateStr}\n${timeZone}`;
}

/**
 * Banner manager that mirrors obsidian-immich-sync/src/render/banner.ts
 * but triggers on `cssclasses: immichBanner` and uses `getPhotosForDate`.
 */
export class ImmichBannerManager {
	private app: App;
	private getSettings: () => ImmichSettings;
	private getPhotosForDate: () => (
		dateStr: string,
		timeZone: string
	) => Promise<ImmichPhoto[]>;
	private getAssetCache: () => AssetFileCache | undefined;

	private requestCounters = new Map<string, number>();
	private refreshTimer: number | null = null;
	/** Pending post-processor frames, keyed by path so split panes don't starve each other. */
	private pendingFrames = new Map<string, number>();

	constructor(
		app: App,
		getSettings: () => ImmichSettings,
		getPhotosForDate: () => (dateStr: string, timeZone: string) => Promise<ImmichPhoto[]>,
		getAssetCache: () => AssetFileCache | undefined
	) {
		this.app = app;
		this.getSettings = getSettings;
		this.getPhotosForDate = getPhotosForDate;
		this.getAssetCache = getAssetCache;
	}

	initialize(plugin: Plugin): void {
		const refreshAll = (): void => {
			this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
				if (leaf.view instanceof MarkdownView) {
					void this.updateBanner(leaf.view);
				}
			});
		};

		// file-open, layout-change and active-leaf-change all fire on a single
		// note open; a trailing debounce collapses them into one sweep once the
		// layout has settled.
		const refreshDeferred = (): void => {
			if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
			this.refreshTimer = window.setTimeout(() => {
				this.refreshTimer = null;
				refreshAll();
			}, 50);
		};

		plugin.registerEvent(this.app.workspace.on("file-open", refreshDeferred));
		plugin.registerEvent(this.app.workspace.on("layout-change", refreshDeferred));
		plugin.registerEvent(this.app.workspace.on("active-leaf-change", refreshDeferred));
		plugin.registerEvent(
			// @ts-ignore metadataCache 'changed' exists
			this.app.metadataCache.on("changed", (file: TFile) => {
				this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
					if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
						void this.updateBanner(leaf.view);
					}
				});
			})
		);

		// Fresh reading-mode renders create .markdown-preview-sizer asynchronously.
		// This runs for every block of every note, so bail synchronously before
		// scheduling any work when the note isn't a banner note at all.
		plugin.registerMarkdownPostProcessor((el, ctx) => {
			const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
			if (!(file instanceof TFile)) return;
			if (!frontmatterHasImmichBanner(getFileFrontmatter(this.app, file))) return;

			// N blocks of the same note in one render pass share a callback
			const path = file.path;
			if (this.pendingFrames.has(path)) return;
			this.pendingFrames.set(
				path,
				window.requestAnimationFrame(() => {
					this.pendingFrames.delete(path);
					const sizer = el.closest(READING_HOST_SELECTOR);
					if (!(sizer instanceof HTMLElement)) return;
					void this.syncBanner(sizer, file);
				}),
			);
		});

		// Two passes: hosts (.markdown-preview-sizer / .cm-sizer) may not be
		// mounted on the first tick, and updateBanner bails when the host is
		// missing. The debounced pass catches them once layout settles.
		this.app.workspace.onLayoutReady(() => {
			refreshAll();
			refreshDeferred();
		});

		refreshAll();
		refreshDeferred();
	}

	destroy(): void {
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		for (const handle of this.pendingFrames.values()) {
			window.cancelAnimationFrame(handle);
		}
		this.pendingFrames.clear();
		for (const view of getMarkdownViews(this.app)) {
			removeAllBanners(view);
		}
		this.requestCounters.clear();
	}

	private async updateBanner(view: MarkdownView): Promise<void> {
		const file = view.file;
		if (!file) {
			removeAllBanners(view);
			return;
		}

		const mode = view.getMode();
		const selector = mode === "preview" ? READING_HOST_SELECTOR : EDITOR_HOST_SELECTOR;
		const host = view.containerEl.querySelector(selector);

		if (!(host instanceof HTMLElement)) {
			// Host not mounted yet – leave existing banner, post-processor or next layout-change will mount
			return;
		}

		const changed = await this.syncBanner(host, file);
		// removeBannersExcept queries the whole rendered note subtree, so skip
		// it on the common no-op sweep
		if (changed) removeBannersExcept(view, host);
	}

	/** @returns false when the banner was already correct and nothing was touched. */
	private async syncBanner(host: HTMLElement, file: TFile): Promise<boolean> {
		const fm = getFileFrontmatter(this.app, file);

		if (!frontmatterHasImmichBanner(fm)) {
			const stale = host.querySelectorAll(`:scope > .${BANNER_CLASS}`);
			stale.forEach((b) => b.remove());
			return stale.length > 0;
		}

		const settings = this.getSettings();
		const dateStr =
			extractFrontmatterString(fm, settings.dateField) ??
			extractFrontmatterString(fm, "date");

		if (!dateStr) {
			const stale = host.querySelectorAll(`:scope > .${BANNER_CLASS}`);
			stale.forEach((b) => b.remove());
			return stale.length > 0;
		}

		const timeZoneStr =
			extractFrontmatterString(fm, settings.timezoneField) ??
			extractFrontmatterString(fm, "timezone") ??
			"UTC";

		const signature = bannerSignature(file.path, dateStr, timeZoneStr);
		const firstChild = host.firstElementChild;
		if (
			firstChild instanceof HTMLElement &&
			firstChild.classList.contains(BANNER_CLASS) &&
			firstChild.dataset.signature === signature
		) {
			return false;
		}

		host.querySelectorAll(`:scope > .${BANNER_CLASS}`).forEach((b) => b.remove());
		await this.mountBanner(host, file, dateStr, timeZoneStr, signature);
		return true;
	}

	private async mountBanner(
		host: HTMLElement,
		file: TFile,
		dateStr: string,
		timeZoneStr: string,
		signature: string
	): Promise<void> {
		const path = file.path;
		const next = (this.requestCounters.get(path) ?? 0) + 1;
		this.requestCounters.set(path, next);
		const requestId = next;

		const banner = host.createDiv({ cls: BANNER_CLASS });
		banner.dataset.signature = signature;

		const bg = banner.createEl("img", { cls: `${BANNER_CLASS}-bg` });
		bg.alt = "";
		bg.setAttribute("aria-hidden", "true");

		const fg = banner.createEl("img", { cls: `${BANNER_CLASS}-fg` });
		fg.alt = dateStr;
		// Above the fold by definition
		fg.loading = "eager";
		fg.setAttribute("fetchpriority", "high");

		const countBadge = banner.createDiv({ cls: `${BANNER_CLASS}-count` });
		// Hide until we know the count
		countBadge.addClass(`${BANNER_CLASS}-count--hidden`);

		// Prepend immediately, similar to sync plugin, so layout is stable
		host.prepend(banner);

		try {
			const fn = this.getPhotosForDate();
			const photos = await fn(dateStr, timeZoneStr);

			if (this.requestCounters.get(path) !== requestId) return;
			// Host may have been detached or file changed
			if (!host.isConnected) return;

			const freshFm = getFileFrontmatter(this.app, file);
			if (!frontmatterHasImmichBanner(freshFm)) {
				banner.remove();
				return;
			}

			const freshDate =
				extractFrontmatterString(freshFm, this.getSettings().dateField) ??
				extractFrontmatterString(freshFm, "date");
			if (freshDate !== dateStr) {
				// Date changed during fetch – let next sync handle it
				banner.remove();
				return;
			}

			if (!photos || photos.length === 0) {
				banner.remove();
				return;
			}

			const first = photos[0];
			if (!first) {
				banner.remove();
				return;
			}

			const src = first.previewUrl || first.thumbnailUrl || first.fullsizeUrl;
			if (!src) {
				banner.remove();
				return;
			}

			// bg is blurred 20px in CSS, so a thumbnail is indistinguishable
			// from the preview and far cheaper to decode and blur
			bg.src = first.thumbnailUrl || src;
			fg.src = src;
			fg.alt = first.originalFileName || dateStr;

			// Update count badge
			countBadge.setText(`${photos.length} photo${photos.length === 1 ? "" : "s"}`);
			countBadge.setAttribute("aria-label", `${photos.length} photos for ${dateStr}`);
			countBadge.removeClass(`${BANNER_CLASS}-count--hidden`);

			const assetCache = this.getAssetCache();

			const openModal = () => {
				new ImmichPhotoModal(this.app, photos, 0, assetCache, this.getSettings().immichApiKey).open();
			};

			banner.addEventListener("click", openModal);
			fg.tabIndex = 0;
			fg.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					openModal();
				}
			});

			// Error fallback chain
			let triedFallback = false;
			fg.addEventListener("error", () => {
				if (triedFallback) {
					banner.addClass(`${BANNER_CLASS}--error`);
					return;
				}
				triedFallback = true;
				const candidates = [first.previewUrl, first.thumbnailUrl, first.fullsizeUrl].filter(
					Boolean
				) as string[];
				const current = fg.src;
				for (const c of candidates) {
					if (c !== current) {
						fg.src = c;
						bg.src = c;
						return;
					}
				}
				banner.addClass(`${BANNER_CLASS}--error`);
			});
		} catch {
			if (this.requestCounters.get(path) !== requestId) return;
			banner.remove();
		}
	}
}

/** Functional wrapper mirroring the sync plugin's export */
export function registerBannerRenderer(
	app: App,
	getSettings: () => ImmichSettings,
	getPhotosForDate: () => (dateStr: string, timeZone: string) => Promise<ImmichPhoto[]>,
	getAssetCache: () => AssetFileCache | undefined,
	plugin: Plugin
): ImmichBannerManager {
	const manager = new ImmichBannerManager(app, getSettings, getPhotosForDate, getAssetCache);
	manager.initialize(plugin);
	return manager;
}
