import { App, MarkdownPostProcessorContext, TFile } from "obsidian";
import { ImmichClient } from "../immich/client";
import { ImmichPhoto, ImmichSettings } from "../types";
import { ImmichPhotoModal } from "./photo-modal";
import { AssetFileCache, DateAssetCache } from "../cache";

type FrontmatterValue = string | number | boolean | Date | null | undefined;
type FrontmatterRecord = Record<string, FrontmatterValue>;

function getFrontmatter(app: App, sourcePath: string): FrontmatterRecord | null {
	try {
		const file = app.vault.getAbstractFileByPath(sourcePath);
		if (!file || !(file instanceof TFile)) return null;
		const cache = app.metadataCache.getFileCache(file);
		return (cache?.frontmatter as FrontmatterRecord) ?? null;
	} catch {
		void 0;
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
			void 0;
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

function createExplicitErrorEl(
	container: HTMLElement,
	err: unknown,
	settings: ImmichSettings,
	dateStr: string,
	timeZoneStr: string,
): HTMLElement {
	const msg = err instanceof Error ? err.message : String(err);
	const serverUrl = settings.immichServerUrl || "(not configured)";

	const wrapper = container.createDiv({ cls: "immich-memories-error" });

	const title = wrapper.createDiv({ cls: "immich-memories-error-title" });
	// Choose title based on message content
	if (msg.toLowerCase().includes("not configured") || msg.toLowerCase().includes("not set")) {
		title.setText("Immich is not configured");
	} else if (msg.includes("Failed to connect") || msg.toLowerCase().includes("network error")) {
		title.setText(`Cannot connect to Immich server at ${serverUrl}`);
	} else if (msg.includes("401") || msg.toLowerCase().includes("authentication failed")) {
		title.setText(`Immich authentication failed (401)`);
	} else if (msg.includes("403")) {
		title.setText(`Immich access forbidden (403)`);
	} else if (msg.includes("404") && msg.includes("endpoint not found")) {
		title.setText(`Immich API endpoint not found (404) — check server URL`);
	} else {
		title.setText(`Failed to load Immich memories for ${dateStr}`);
	}

	const body = wrapper.createDiv({ cls: "immich-memories-error-body" });
	body.setText(msg);

	const meta = wrapper.createDiv({ cls: "immich-memories-error-meta" });
	meta.createDiv({ text: `Server: ${serverUrl}` });
	meta.createDiv({ text: `Requested: ${dateStr} in ${timeZoneStr}` });

	const help = wrapper.createDiv({ cls: "immich-memories-error-help" });
	help.createEl("strong", { text: "Troubleshooting:" });
	const ul = help.createEl("ul");
	const tips: string[] = [];
	if (!settings.immichServerUrl) {
		tips.push("Set server URL in Settings → Immich Memories (e.g. https://immich.example.com, no trailing /api).");
	} else {
		tips.push(`Verify server URL is correct and reachable: ${serverUrl} should open Immich in a browser.`);
		tips.push("Base URL should NOT include /api – the plugin appends /api/search/metadata itself.");
	}
	if (!settings.immichApiKey) {
		tips.push("Set API key in Settings → Immich Memories. Create it in Immich → Account Settings → API Keys.");
	} else if (msg.includes("401") || msg.includes("403")) {
		tips.push("Your API key may be invalid or lack search permission. Regenerate it in Immich and update settings.");
	}
	if (msg.includes("404")) {
		tips.push("Endpoint /api/search/metadata requires Immich v1.90+. Update Immich if you run an older version.");
		tips.push("If behind reverse proxy (nginx, Cloudflare), ensure POST /api/search/metadata is not blocked.");
	}
	if (msg.toLowerCase().includes("network") || msg.includes("Failed to connect")) {
		tips.push("Check network/DNS, VPN, firewall, and that the Immich server is running.");
		tips.push("Self-signed certificates may be rejected by Electron – add CA or use valid cert.");
	}
	if (tips.length === 0) {
		tips.push("Check Immich server logs for errors.");
		tips.push("Verify API key has 'asset.read' and search permissions.");
	}
	for (const tip of tips) {
		ul.createEl("li", { text: tip });
	}

	return wrapper;
}

export function createImmichBlockProcessor(
	app: App,
	getClient: () => ImmichClient,
	getSettings: () => ImmichSettings,
	getAssetCache?: () => AssetFileCache,
	getDateCache?: () => DateAssetCache,
) {
	return async function processor(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		el.addClass("immich-memories-root");
		el.empty();

		const overrides = parseCodeblockParams(source);

		const fm = getFrontmatter(app, ctx.sourcePath);
		const settings = getSettings();
		const client = getClient();
		const assetCache = getAssetCache?.();
		const dateCache = getDateCache?.();

		if (!client.isConfigured()) {
			const wrapper = el.createDiv({ cls: "immich-memories-error" });
			wrapper.createDiv({ cls: "immich-memories-error-title", text: "Immich is not configured" });
			wrapper.createDiv({
				cls: "immich-memories-error-body",
				text: `Server URL and/or API key missing. Current server URL: ${settings.immichServerUrl || "(empty)"}. Open Settings → Immich Memories to configure.`,
			});
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

		let usedDateCache = false;
		if (settings.useDateCache && dateCache) {
			try {
				const cachedEntry = await dateCache.get(dateStr, timeZoneStr);
				if (cachedEntry && cachedEntry.assetIds.length > 0) {
					photos = cachedEntry.assetIds.map((id) => {
						const thumbLocal = settings.useAssetCache ? assetCache?.getThumbnailLocalUrl(id) : null;
						const fullLocal = settings.useAssetCache ? assetCache?.getFullsizeLocalUrl(id) : null;
						return {
							assetId: id,
							thumbnailUrl: thumbLocal ?? client.getThumbnailUrl(id),
							fullsizeUrl: fullLocal ?? client.getFullsizeUrl(id),
						};
					});
					usedDateCache = photos.length > 0;
				}
			} catch {
				void 0;
			}
		}

		if (!usedDateCache) {
			try {
				const remotePhotos = await client.getPhotosForDate(dateStr, timeZoneStr);

				if (settings.useDateCache && dateCache) {
					try {
						await dateCache.set(
							dateStr,
							timeZoneStr,
							remotePhotos.map((p) => p.assetId),
						);
					} catch {
						void 0;
					}
				}

				photos = remotePhotos.map((p) => {
					const thumbLocal = settings.useAssetCache ? assetCache?.getThumbnailLocalUrl(p.assetId) : null;
					const fullLocal = settings.useAssetCache ? assetCache?.getFullsizeLocalUrl(p.assetId) : null;
					return {
						...p,
						thumbnailUrl: thumbLocal ?? p.thumbnailUrl,
						fullsizeUrl: fullLocal ?? p.fullsizeUrl,
					};
				});

				if (settings.useAssetCache && assetCache) {
					const apiKey = settings.immichApiKey;
					void (async () => {
						for (const p of remotePhotos) {
							try {
								if (assetCache.getThumbnailLocalUrl(p.assetId)) continue;
								await assetCache.ensureThumbnailCached(p.assetId, p.thumbnailUrl, apiKey);
							} catch {
								void 0;
							}
						}
					})();
				}
			} catch (err: unknown) {
				loadingEl.remove();
				createExplicitErrorEl(el, err, settings, dateStr, timeZoneStr);
				return;
			}
		}

		loadingEl.remove();

		if (photos.length === 0) {
			createMessageEl(el, `No photos found in Immich for ${dateStr} in timezone ${timeZoneStr}. The connection succeeded, but no assets matched that day.`);
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
			new ImmichPhotoModal(app, photos, 0, assetCache).open();
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
				new ImmichPhotoModal(app, photos, i, assetCache).open();
			});

			thumb.tabIndex = 0;
			thumb.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					new ImmichPhotoModal(app, photos, i, assetCache).open();
				}
			});
		}
	};
}
