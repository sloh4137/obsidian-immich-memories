import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, ImmichPhoto, ImmichPublicApi, ImmichSettings } from "./types";
import { ImmichClient } from "./immich/client";
import { ImmichSettingTab } from "./settings";
import { createImmichBlockProcessor } from "./ui/renderer";
import { getDayRangeUtc } from "./immich/date-utils";
import { AssetFileCache, DateAssetCache } from "./cache";

export default class ImmichMemoriesPlugin extends Plugin {
	settings!: ImmichSettings;
	private client!: ImmichClient;

	/** File caches */
	assetCache!: AssetFileCache;
	dateCache!: DateAssetCache;

	/** Public API exposed to other plugins via app.plugins.plugins['obsidian-immich-memories'].api */
	public api!: ImmichPublicApi;

	async onload() {
		await this.loadSettings();

		this.client = new ImmichClient(this.settings.immichServerUrl, this.settings.immichApiKey);

		this.assetCache = new AssetFileCache(this.app, () => this.settings, this.manifest.id);
		this.dateCache = new DateAssetCache(this.app, () => this.settings, this.manifest.id);

		// Initialize caches in background (don't block startup)
		this.assetCache.initialize().catch(() => {});
		this.dateCache
			.initialize()
			.then(() => this.dateCache.cleanup())
			.catch(() => {});

		this.api = this.buildPublicApi();

		this.addSettingTab(new ImmichSettingTab(this.app, this));

		this.registerMarkdownCodeBlockProcessor(
			"obsidian-immich-memories",
			createImmichBlockProcessor(this.app, () => this.client, () => this.settings, () => this.assetCache, () => this.dateCache),
		);

		this.registerMarkdownCodeBlockProcessor(
			"immich-memories",
			createImmichBlockProcessor(this.app, () => this.client, () => this.settings, () => this.assetCache, () => this.dateCache),
		);

		// Regular cleanup schedule for date cache every hour
		this.registerInterval(
			window.setInterval(() => {
				void this.dateCache.cleanup();
			}, 60 * 60 * 1000),
		);

		// Also enforce asset cache size periodically every 30 minutes
		this.registerInterval(
			window.setInterval(() => {
				void this.assetCache.enforceSizeLimit();
			}, 30 * 60 * 1000),
		);
	}

	onunload() {}

	async loadSettings() {
		const loaded = (await this.loadData()) as Partial<ImmichSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
		this.settings.dateField = this.settings.dateField?.trim() || DEFAULT_SETTINGS.dateField;
		this.settings.timezoneField = this.settings.timezoneField?.trim() || DEFAULT_SETTINGS.timezoneField;
		// Migrate old settings or ensure defaults
		if (typeof this.settings.useAssetCache !== "boolean") this.settings.useAssetCache = DEFAULT_SETTINGS.useAssetCache;
		if (typeof this.settings.assetCacheSizeMB !== "number") this.settings.assetCacheSizeMB = DEFAULT_SETTINGS.assetCacheSizeMB;
		if (typeof this.settings.useDateCache !== "boolean") this.settings.useDateCache = DEFAULT_SETTINGS.useDateCache;
		if (typeof this.settings.dateCacheRetentionDays !== "number")
			this.settings.dateCacheRetentionDays = DEFAULT_SETTINGS.dateCacheRetentionDays;
		if (!this.settings.assetCacheFolder) this.settings.assetCacheFolder = "";
	}

	async saveSettings() {
		await this.saveData(this.settings);
		if (this.client) {
			this.client.updateConfig(this.settings.immichServerUrl, this.settings.immichApiKey);
		}
	}

	// --- Public API methods ---

	/**
	 * Get photos for a calendar day + timezone.
	 * Uses date cache if enabled, and uses asset cache for local URLs.
	 */
	async getPhotosForDate(dateStr: string, timeZone: string): Promise<ImmichPhoto[]> {
		// Try date cache first
		if (this.settings.useDateCache) {
			try {
				const cached = await this.dateCache.get(dateStr, timeZone);
				if (cached && cached.assetIds.length > 0) {
					return this.buildPhotosFromAssetIds(cached.assetIds);
				}
			} catch {
				// fall through to remote
			}
		}

		// Remote fetch
		const photos = await this.client.getPhotosForDate(dateStr, timeZone);

		// Populate date cache
		if (this.settings.useDateCache) {
			try {
				const assetIds = photos.map((p) => p.assetId);
				await this.dateCache.set(dateStr, timeZone, assetIds);
			} catch {
				// ignore
			}
		}

		// Populate asset cache thumbnails in background (fire and forget)
		if (this.settings.useAssetCache) {
			void this.cacheThumbnailsInBackground(photos);
		}

		// Return with local URLs if available
		return photos.map((p) => this.applyLocalUrls(p));
	}

	/** Alias */
	async findPhotos(dateStr: string, timeZone: string): Promise<ImmichPhoto[]> {
		return this.getPhotosForDate(dateStr, timeZone);
	}

	/** Get thumbnail URL given an assetId – returns local path if cached */
	getThumbnailUrl(assetId: string): string {
		if (this.settings?.useAssetCache) {
			const local = this.assetCache?.getThumbnailLocalUrl(assetId);
			if (local) return local;
		}
		return this.client.getThumbnailUrl(assetId);
	}

	/** Get fullsize image URL given an assetId – returns local path if cached */
	getFullsizeUrl(assetId: string): string {
		if (this.settings?.useAssetCache) {
			const local = this.assetCache?.getFullsizeLocalUrl(assetId);
			if (local) return local;
		}
		return this.client.getFullsizeUrl(assetId);
	}

	/** Helper for range queries */
	async searchByDateRangeTaken(takenAfter: string, takenBefore: string): Promise<ImmichPhoto[]> {
		const photos = await this.client.searchByDateRangeTaken(takenAfter, takenBefore);
		return photos.map((p) => this.applyLocalUrls(p));
	}

	getDayRangeUtc(dateStr: string, timeZone: string) {
		return getDayRangeUtc(dateStr, timeZone);
	}

	/** Build photos from assetIds using URLs (local if cached) */
	private buildPhotosFromAssetIds(assetIds: string[]): ImmichPhoto[] {
		return assetIds.map((id) => ({
			assetId: id,
			thumbnailUrl: this.getThumbnailUrl(id),
			fullsizeUrl: this.getFullsizeUrl(id),
		}));
	}

	private applyLocalUrls(photo: ImmichPhoto): ImmichPhoto {
		const thumbLocal = this.settings.useAssetCache ? this.assetCache?.getThumbnailLocalUrl(photo.assetId) : null;
		const fullLocal = this.settings.useAssetCache ? this.assetCache?.getFullsizeLocalUrl(photo.assetId) : null;
		return {
			...photo,
			thumbnailUrl: thumbLocal ?? photo.thumbnailUrl,
			fullsizeUrl: fullLocal ?? photo.fullsizeUrl,
		};
	}

	private async cacheThumbnailsInBackground(photos: ImmichPhoto[]): Promise<void> {
		const apiKey = this.settings.immichApiKey;
		for (const p of photos) {
			try {
				// Only cache if not already cached
				if (this.assetCache.getThumbnailLocalUrl(p.assetId)) continue;
				// Use remote thumbnail URL (strip apiKey param to use header version)
				// The client already builds URL with apiKey query, requestUrl will use header too
				await this.assetCache.ensureThumbnailCached(p.assetId, p.thumbnailUrl, apiKey);
			} catch {
				// ignore per asset
			}
		}
	}

	/* ---- Cache management for public API ---- */

	async clearAssetCache(): Promise<void> {
		await this.assetCache.clear();
	}

	async clearDateCache(): Promise<void> {
		await this.dateCache.clear();
	}

	getAssetCacheSizeMB(): number {
		return this.assetCache?.getTotalSizeMB() ?? 0;
	}

	private buildPublicApi(): ImmichPublicApi {
		return {
			getPhotosForDate: this.getPhotosForDate.bind(this),
			findPhotos: this.findPhotos.bind(this),
			getThumbnailUrl: this.getThumbnailUrl.bind(this),
			getFullsizeUrl: this.getFullsizeUrl.bind(this),
			searchByDateRangeTaken: this.searchByDateRangeTaken.bind(this),
			clearAssetCache: this.clearAssetCache.bind(this),
			clearDateCache: this.clearDateCache.bind(this),
			getAssetCacheSizeMB: this.getAssetCacheSizeMB.bind(this),
		};
	}
}
