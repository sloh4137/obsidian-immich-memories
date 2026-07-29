export interface ImmichPhoto {
	assetId: string;
	thumbnailUrl: string;
	fullsizeUrl: string;
	/** Optional extra metadata if available from Immich */
	takenAt?: string;
	originalFileName?: string;
	type?: string;
}

export interface ImmichSettings {
	immichServerUrl: string;
	immichApiKey: string;
	dateField: string;
	timezoneField: string;
	/** If true, cache blob URLs to avoid re-fetching */
	useBlobCache?: boolean;
}

export const DEFAULT_SETTINGS: ImmichSettings = {
	immichServerUrl: "",
	immichApiKey: "",
	dateField: "date",
	timezoneField: "timezone",
	useBlobCache: false,
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
}
