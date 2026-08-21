export interface ImmichPhoto {
	assetId: string;
	thumbnailUrl: string;
	fullsizeUrl: string;
	/** Optional extra metadata if available from Immich */
	takenAt?: string;
	originalFileName?: string;
	type?: string;
	/** If this asset is a live photo image, points to its motion video asset id */
	livePhotoVideoId?: string | null;
}

export interface ImmichSettings {
	immichServerUrl: string;
	immichApiKey: string;
	dateField: string;
	timezoneField: string;
	/** Deprecated: old blob cache flag */
	useBlobCache?: boolean;

	/* ---- Asset file cache ---- */
	/** Whether to use local filesystem cache for thumbnails/full */
	useAssetCache: boolean;
	/** Max size in MB for asset cache */
	assetCacheSizeMB: number;
	/** Optional custom folder relative to vault root; defaults to .obsidian/plugins/<id>/cache */
	assetCacheFolder?: string;

	/* ---- Date -> assetIds cache ---- */
	/** Whether to cache date queries */
	useDateCache: boolean;
	/** How many days to keep date entries before eviction based on lastSearched */
	dateCacheRetentionDays: number;
	/** Optional max entries (0 = unlimited) */
	dateCacheMaxEntries?: number;

	/** Migration version for live-photo video filtering (clears old date cache once) */
	dateCacheFilterVersion?: number;
}

export const DEFAULT_SETTINGS: ImmichSettings = {
	immichServerUrl: "",
	immichApiKey: "",
	dateField: "date",
	timezoneField: "timezone",
	useBlobCache: false,
	useAssetCache: true,
	assetCacheSizeMB: 200,
	assetCacheFolder: "",
	useDateCache: true,
	dateCacheRetentionDays: 30,
	dateCacheMaxEntries: 500,
	dateCacheFilterVersion: 0,
};

export interface ImmichPublicApi {
	/**
	 * Find all photos taken on a given day in a timezone.
	 * @param dateStr - Date string in YYYY-MM-DD format or ISO date. Parsed as calendar date.
	 * @param timeZone - IANA timezone, e.g. "America/New_York". If empty, UTC is assumed.
	 */
	getPhotosForDate(dateStr: string, timeZone: string): Promise<ImmichPhoto[]>;
	/** Alias for getPhotosForDate */
	findPhotos(dateStr: string, timeZone: string): Promise<ImmichPhoto[]>;

	/** Get thumbnail URL for a given assetId */
	getThumbnailUrl(assetId: string): string;
	/** Get fullsize/original URL for a given assetId */
	getFullsizeUrl(assetId: string): string;

	/** Low-level helper to fetch raw assets between two UTC ISO timestamps */
	searchByDateRangeTaken(takenAfter: string, takenBefore: string): Promise<ImmichPhoto[]>;

	/** Cache management */
	clearAssetCache(): Promise<void>;
	clearDateCache(): Promise<void>;
	getAssetCacheSizeMB(): number;
}

export interface ImmichAsset {
	id: string;
	type?: string;
	originalFileName?: string;
	exifInfo?: {
		dateTimeOriginal?: string;
	};
	fileCreatedAt?: string;
	localDateTime?: string;
	/** For live photos, the image asset points to its motion video asset */
	livePhotoVideoId?: string | null;
}

/* ----- Cache data structures ----- */

export interface AssetCacheRecord {
	assetId: string;
	thumbnailRelativePath?: string;
	fullsizeRelativePath?: string;
	thumbnailSize: number;
	fullsizeSize: number;
	lastAccessed: number;
	createdAt: number;
}

export interface DateCacheEntry {
	key: string; // date|timezone composite
	dateStr: string;
	timeZone: string;
	assetIds: string[];
	lastSearched: number;
	createdAt: number;
}
