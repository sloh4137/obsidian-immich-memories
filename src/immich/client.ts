import { requestUrl, RequestUrlResponse } from "obsidian";
import { ImmichAsset, ImmichPhoto } from "../types";
import { getDayRangeUtc, normalizeTimeZone } from "./date-utils";

export type FetchFn = typeof requestUrl;

export class ImmichClient {
	private serverUrl: string;
	private apiKey: string;
	private fetch: FetchFn;

	constructor(serverUrl: string, apiKey: string, fetchFn?: FetchFn) {
		this.serverUrl = (serverUrl || "").trim().replace(/\/+$/, "");
		this.apiKey = (apiKey || "").trim();
		// Allow injection for tests; default to Obsidian requestUrl which bypasses CORS
		this.fetch = fetchFn ?? requestUrl;
	}

	updateConfig(serverUrl: string, apiKey: string) {
		this.serverUrl = (serverUrl || "").trim().replace(/\/+$/, "");
		this.apiKey = (apiKey || "").trim();
	}

	isConfigured(): boolean {
		return !!this.serverUrl && !!this.apiKey;
	}

	getServerUrl(): string {
		return this.serverUrl;
	}

	/**
	 * Public API: thumbnail URL.
	 * Includes apiKey as query param so <img> tags can load without custom headers in browsers/Electron.
	 * Consumers can strip query if they plan to fetch with header instead.
	 */
	getThumbnailUrl(assetId: string): string {
		if (!this.serverUrl || !assetId) return "";
		const base = `${this.serverUrl}/api/assets/${encodeURIComponent(assetId)}/thumbnail`;
		// Immich supports ?size=thumbnail|preview. We request thumbnail size for grid.
		// Include api key as query for direct img usage; requestUrl users may prefer header.
		return this.apiKey ? `${base}?size=thumbnail&apiKey=${encodeURIComponent(this.apiKey)}` : `${base}?size=thumbnail`;
	}

	/**
	 * Public API: fullsize URL. Returns original file.
	 */
	getFullsizeUrl(assetId: string): string {
		if (!this.serverUrl || !assetId) return "";
		const base = `${this.serverUrl}/api/assets/${encodeURIComponent(assetId)}/original`;
		return this.apiKey ? `${base}?apiKey=${encodeURIComponent(this.apiKey)}` : base;
	}

	/**
	 * Alternative preview URL (large but not original) for modal fallback
	 */
	getPreviewUrl(assetId: string): string {
		if (!this.serverUrl || !assetId) return "";
		const base = `${this.serverUrl}/api/assets/${encodeURIComponent(assetId)}/thumbnail`;
		return this.apiKey ? `${base}?size=preview&apiKey=${encodeURIComponent(this.apiKey)}` : `${base}?size=preview`;
	}

	private async doFetch(url: string, method = "GET", body?: string): Promise<RequestUrlResponse> {
		if (!this.isConfigured()) {
			throw new Error("Immich server URL and API key must be configured in settings");
		}
		const headers: Record<string, string> = {
			"x-api-key": this.apiKey,
		};
		if (body) {
			headers["Content-Type"] = "application/json";
		}
		return this.fetch({
			url,
			method,
			headers,
			body,
			throw: false,
		});
	}

	/**
	 * Low-level search raw response handling for various Immich API versions.
	 */
	private extractAssetsFromResponse(json: unknown): ImmichAsset[] {
		if (!json) return [];

		if (Array.isArray(json)) {
			return json as ImmichAsset[];
		}

		if (typeof json === "object" && json !== null) {
			const obj = json as Record<string, unknown>;

			if (obj.assets !== undefined) {
				const assets = obj.assets as unknown;
				if (Array.isArray(assets)) return assets as ImmichAsset[];
				if (typeof assets === "object" && assets !== null) {
					const assetObj = assets as Record<string, unknown>;
					if (Array.isArray(assetObj.items)) {
						return assetObj.items as ImmichAsset[];
					}
				}
			}

			if (Array.isArray(obj.items)) {
				return obj.items as ImmichAsset[];
			}
		}

		return [];
	}

	/**
	 * Search assets by takenAfter / takenBefore using /api/search/metadata.
	 * Falls back to /api/search if metadata endpoint not available.
	 */
	async searchByDateRangeTaken(takenAfter: string, takenBefore: string): Promise<ImmichPhoto[]> {
		// Primary endpoint: POST /api/search/metadata
		const endpoint = `${this.serverUrl}/api/search/metadata`;

		const payload = {
			takenAfter,
			takenBefore,
			// Immich supports type filter; we default to no filter but could query IMAGE
			// Keeping generic to include videos too; caller can filter if needed.
			size: 1000,
		};

		const res: RequestUrlResponse = await this.doFetch(endpoint, "POST", JSON.stringify(payload));

		if (res.status >= 200 && res.status < 300) {
			const assets = this.extractAssetsFromResponse(res.json);
			return this.mapAssetsToPhotos(assets);
		}

		// Fallback: Try older /api/search/metadata without size or with different shape
		// Second try with simpler body
		if (res.status === 404 || res.status === 400) {
			const fallbackPayload = {
				takenAfter,
				takenBefore,
			};
			const fallbackRes = await this.doFetch(endpoint, "POST", JSON.stringify(fallbackPayload));
			if (fallbackRes.status >= 200 && fallbackRes.status < 300) {
				const assets = this.extractAssetsFromResponse(fallbackRes.json);
				return this.mapAssetsToPhotos(assets);
			}
		}

		// If still failing, throw with details
		const msg = typeof res.json === "object" ? JSON.stringify(res.json) : res.text;
		throw new Error(`Immich search failed (${res.status}): ${msg}`);
	}

	private mapAssetsToPhotos(assets: ImmichAsset[]): ImmichPhoto[] {
		return assets
			.filter((a) => !!a.id)
			.map((a) => ({
				assetId: a.id,
				thumbnailUrl: this.getThumbnailUrl(a.id),
				fullsizeUrl: this.getFullsizeUrl(a.id),
				takenAt: a.exifInfo?.dateTimeOriginal ?? a.fileCreatedAt ?? a.localDateTime,
				originalFileName: a.originalFileName,
				type: a.type,
			}));
	}

	/**
	 * Public API: find photos for a given calendar day and timezone.
	 */
	async getPhotosForDate(dateStr: string, timeZone: string): Promise<ImmichPhoto[]> {
		const tz = normalizeTimeZone(timeZone);
		const range = getDayRangeUtc(dateStr, tz);
		if (!range) {
			throw new Error(`Invalid date string: ${dateStr}. Expected YYYY-MM-DD`);
		}
		return this.searchByDateRangeTaken(range.takenAfter, range.takenBefore);
	}
}
