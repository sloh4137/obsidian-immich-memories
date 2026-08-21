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
			createImmichBlockProcessor(
				this.app,
				() => this.client,
				() => this.settings,
				() => this.assetCache,
				() => this.dateCache,
				() => this.getPhotosForDate.bind(this)
			),
		);

		this.registerMarkdownCodeBlockProcessor(
			"immich-memories",
			createImmichBlockProcessor(
				this.app,
				() => this.client,
				() => this.settings,
				() => this.assetCache,
				() => this.dateCache,
				() => this.getPhotosForDate.bind(this)
			),
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

	private filterLivePhotoVideos(photos: ImmichPhoto[]): ImmichPhoto[] {
		// Primary: drop any photo whose id is referenced as livePhotoVideoId
		const liveVideoIds = new Set<string>();
		for (const p of photos) {
			if (p.livePhotoVideoId) liveVideoIds.add(p.livePhotoVideoId);
		}
		if (liveVideoIds.size > 0) {
			return photos.filter((p) => !liveVideoIds.has(p.assetId));
		}

		// Fallback: HEIC + same-basename MOV considered live-photo pair
		const heicBasenames = new Set<string>();
		for (const p of photos) {
			if (p.type !== 'IMAGE') continue;
			const name = p.originalFileName;
			if (!name) continue;
			const lower = name.toLowerCase();
			if (lower.endsWith('.heic') || lower.endsWith('.heif')) {
				const base = name.slice(0, name.lastIndexOf('.')).toLowerCase();
				if (base) heicBasenames.add(base);
			}
		}
		if (heicBasenames.size === 0) return photos;

		const movIds = new Set<string>();
		for (const p of photos) {
			if (p.type !== 'VIDEO') continue;
			const name = p.originalFileName;
			if (!name) continue;
			if (!name.toLowerCase().endsWith('.mov')) continue;
			const base = name.slice(0, name.lastIndexOf('.')).toLowerCase();
			if (base && heicBasenames.has(base)) movIds.add(p.assetId);
		}
		if (movIds.size === 0) return photos;
		return photos.filter((p) => !movIds.has(p.assetId));
	}

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
					const cachedPhotos = this.buildPhotosFromAssetIds(cached.assetIds);
					// Best-effort filter for cached entries that might still
					// have livePhotoVideoId metadata (future-proof). Old
					// entries without that metadata were cleared via migration.
					return this.filterLivePhotoVideos(cachedPhotos);
				}
			} catch {
				// fall through to remote
			}
		}

		// Remote fetch (client already filters out live-photo MOVs)
		const photos = await this.client.getPhotosForDate(dateStr, timeZone);

		// Ensure filtering at API layer as well (defense in depth)
		const filtered = this.filterLivePhotoVideos(photos);

		// Populate date cache with filtered ids
		if (this.settings.useDateCache) {
			try {
				const assetIds = filtered.map((p) => p.assetId);
				await this.dateCache.set(dateStr, timeZone, assetIds);
			} catch {
				// ignore
			}
		}

		// Populate asset cache thumbnails in background (fire and forget)
		if (this.settings.useAssetCache) {
			void this.cacheThumbnailsInBackground(filtered);
		}

		// Return with local URLs if available
		return filtered.map((p) => this.applyLocalUrls(p));
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

	/** Get preview (higher-quality JPEG) URL – useful for HEIC originals */
	getPreviewUrl(assetId: string): string {
		return this.client.getPreviewUrl(assetId);
	}

	/** Helper for range queries */
	async searchByDateRangeTaken(takenAfter: string, takenBefore: string): Promise<ImmichPhoto[]> {
		const photos = await this.client.searchByDateRangeTaken(takenAfter, takenBefore);
		const filtered = this.filterLivePhotoVideos(photos);
		return filtered.map((p) => this.applyLocalUrls(p));
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
			previewUrl: this.getPreviewUrl(id),
		}));
	}

	private applyLocalUrls(photo: ImmichPhoto): ImmichPhoto {
		const thumbLocal = this.settings.useAssetCache ? this.assetCache?.getThumbnailLocalUrl(photo.assetId) : null;
		const fullLocal = this.settings.useAssetCache ? this.assetCache?.getFullsizeLocalUrl(photo.assetId) : null;
		return {
			...photo,
			thumbnailUrl: thumbLocal ?? photo.thumbnailUrl,
			fullsizeUrl: fullLocal ?? photo.fullsizeUrl,
			previewUrl: photo.previewUrl ?? this.client.getPreviewUrl(photo.assetId),
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
			getPreviewUrl: this.getPreviewUrl.bind(this),
			searchByDateRangeTaken: this.searchByDateRangeTaken.bind(this),
			clearAssetCache: this.clearAssetCache.bind(this),
			clearDateCache: this.clearDateCache.bind(this),
			getAssetCacheSizeMB: this.getAssetCacheSizeMB.bind(this),
		};
	}
}
