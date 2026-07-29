import { App, MarkdownPostProcessorContext, TFile } from "obsidian";
import { ImmichClient } from "../immich/client";
import { ImmichPhoto, ImmichSettings } from "../types";
import { ImmichPhotoModal } from "./photo-modal";

type FrontmatterValue = string | number | boolean | Date | null | undefined;
type FrontmatterRecord = Record<string, FrontmatterValue>;

function getFrontmatter(app: App, sourcePath: string): FrontmatterRecord | null {
	try {
		const file = app.vault.getAbstractFileByPath(sourcePath);
		if (!file || !(file instanceof TFile)) return null;
		const cache = app.metadataCache.getFileCache(file);
		return (cache?.frontmatter as FrontmatterRecord) ?? null;
	} catch {
		return null;
	}
}

function parseCodeblockParams(source: string): { dateOverride?: string; timezoneOverride?: string } {
	const trimmed = source.trim();
	if (!trimmed) return {};

	if (trimmed.startsWith("{")) {
		try {
			const obj = JSON.parse(trimmed) as Record<string, unknown>;
			const getStr = (keys: string[]): string | undefined => {
				for (const k of keys) {
					const v = obj[k];
					if (typeof v === "string" && v) return v;
				}
				return undefined;
			};
			return {
				dateOverride: getStr(["date", "day", "taken"]),
				timezoneOverride: getStr(["timezone", "timeZone", "tz"]),
			};
		} catch {
			// fall through
		}
	}

	let dateOverride: string | undefined;
	let timezoneOverride: string | undefined;

	for (const line of trimmed.split("\n")) {
		const split = line.split(":");
		if (split.length < 2) continue;
		const rawKey = split[0];
		if (!rawKey) continue;
		const key = rawKey.trim().toLowerCase();
		const value = split.slice(1).join(":").trim();
		if (!value) continue;
		if (["date", "day", "taken"].includes(key)) dateOverride = value;
		if (["timezone", "tz", "timezone", "time_zone"].includes(key) || key === "timezone") timezoneOverride = value;
		if (key === "time_zone" || key === "time zone") timezoneOverride = value;
	}

	return { dateOverride, timezoneOverride };
}

function extractFrontmatterValue(fm: FrontmatterRecord, fieldName: string): string | null {
	if (!fm) return null;
	const direct = fm[fieldName];
	if (direct != null) {
		if (typeof direct === "string") return direct;
		if (direct instanceof Date) return direct.toISOString().slice(0, 10);
		return String(direct);
	}
	const lower = fieldName.toLowerCase();
	for (const k of Object.keys(fm)) {
		if (k.toLowerCase() === lower) {
			const v = fm[k];
			if (v != null) return String(v);
		}
	}
	return null;
}

function createMessageEl(container: HTMLElement, message: string, cls = "immich-memories-message"): HTMLElement {
	const el = container.createDiv({ cls });
	el.setText(message);
	return el;
}

export function createImmichBlockProcessor(
	app: App,
	getClient: () => ImmichClient,
	getSettings: () => ImmichSettings,
) {
	return async function processor(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		el.addClass("immich-memories-root");
		el.empty();

		const overrides = parseCodeblockParams(source);

		const fm = getFrontmatter(app, ctx.sourcePath);
		const settings = getSettings();
		const client = getClient();

		if (!client.isConfigured()) {
			createMessageEl(el, "Immich server URL and API key are not configured. Set them in Settings → Immich Memories.");
			return;
		}

		if (!fm && !overrides.dateOverride) {
			createMessageEl(el, `No frontmatter found for ${ctx.sourcePath} and no date override in codeblock. Add "${settings.dateField}: YYYY-MM-DD" to frontmatter.`);
			return;
		}

		let dateStr: string | null = overrides.dateOverride ?? null;
		let timeZoneStr: string | null = overrides.timezoneOverride ?? null;

		if (!dateStr && fm) {
			dateStr = extractFrontmatterValue(fm, settings.dateField);
		}
		if (!timeZoneStr && fm) {
			timeZoneStr = extractFrontmatterValue(fm, settings.timezoneField) || "UTC";
		}
		if (!timeZoneStr) timeZoneStr = "UTC";

		if (!dateStr) {
			createMessageEl(
				el,
				`Date not found in frontmatter field "${settings.dateField}". Add it to your note's frontmatter or supply it in the codeblock like "date: YYYY-MM-DD".`,
			);
			return;
		}

		const loadingEl = createMessageEl(el, `Loading Immich memories for ${dateStr} (${timeZoneStr})...`, "immich-memories-loading");

		let photos: ImmichPhoto[] = [];
		try {
			photos = await client.getPhotosForDate(dateStr, timeZoneStr);
		} catch (err: unknown) {
			loadingEl.remove();
			const msg = err instanceof Error ? err.message : String(err);
			createMessageEl(el, `Failed to fetch from Immich: ${msg}`, "immich-memories-error");
			return;
		}

		loadingEl.remove();

		if (photos.length === 0) {
			createMessageEl(el, `No photos found for ${dateStr} in timezone ${timeZoneStr}.`);
			return;
		}

		const container = el.createDiv({ cls: "immich-memories-container" });

		const previewSection = container.createDiv({ cls: "immich-memories-preview-section" });
		previewSection.createDiv({ cls: "immich-memories-preview-label", text: `Memory from ${dateStr}` });

		const firstPhoto = photos[0];
		if (!firstPhoto) return;
		const previewImg = previewSection.createEl("img", { cls: "immich-memories-preview-img" });
		previewImg.src = firstPhoto.thumbnailUrl;
		previewImg.alt = firstPhoto.originalFileName || "Preview";
		previewImg.loading = "lazy";

		previewImg.addEventListener("click", () => {
			new ImmichPhotoModal(app, photos, 0).open();
		});

		const details = container.createEl("details", { cls: "immich-memories-details" });
		const summary = details.createEl("summary", { cls: "immich-memories-summary" });
		summary.setText(`Show all ${photos.length} photos`);

		const gallery = details.createDiv({ cls: "immich-memories-gallery" });

		for (let i = 0; i < photos.length; i++) {
			const photo = photos[i];
			if (!photo) continue;
			const thumbWrapper = gallery.createDiv({ cls: "immich-memories-thumb-wrapper" });
			const thumb = thumbWrapper.createEl("img", { cls: "immich-memories-thumb" });
			thumb.src = photo.thumbnailUrl;
			thumb.alt = photo.originalFileName || `Photo ${i + 1}`;
			thumb.loading = "lazy";
			thumb.setAttr("data-asset-id", photo.assetId);

			thumb.addEventListener("click", () => {
				new ImmichPhotoModal(app, photos, i).open();
			});

			thumb.tabIndex = 0;
			thumb.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					new ImmichPhotoModal(app, photos, i).open();
				}
			});
		}
	};
}
