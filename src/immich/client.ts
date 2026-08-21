import { requestUrl, RequestUrlResponse } from 'obsidian';
import { ImmichAsset, ImmichPhoto } from '../types';
import { getDayRangeUtc, normalizeTimeZone } from './date-utils';

export type FetchFn = typeof requestUrl;

function extractErrorBody(res: RequestUrlResponse): string {
	try {
		const json = res.json as unknown;
		if (typeof json === 'object' && json !== null) {
			const obj = json as Record<string, unknown>;
			if (typeof obj.message === 'string' && obj.message)
				return obj.message;
			if (typeof obj.error === 'string' && obj.error) return obj.error;
			if (typeof obj.msg === 'string' && obj.msg) return obj.msg;
			// Some Immich errors nest under statusCode, message
			if (obj.statusCode && obj.message) {
				const code =
					typeof obj.statusCode === 'string' ||
					typeof obj.statusCode === 'number'
						? String(obj.statusCode)
						: JSON.stringify(obj.statusCode);
				return `${code} ${obj.message as string}`;
			}
			return JSON.stringify(json);
		}
	} catch {
		void 0;
	}
	if (typeof res.text === 'string' && res.text.trim()) {
		// Truncate very long HTML
		const t = res.text.trim();
		return t.length > 500 ? `${t.slice(0, 500)}…` : t;
	}
	return `HTTP ${res.status}`;
}

export class ImmichClient {
	private serverUrl: string;
	private apiKey: string;
	private fetch: FetchFn;

	constructor(serverUrl: string, apiKey: string, fetchFn?: FetchFn) {
		this.serverUrl = (serverUrl || '').trim().replace(/\/+$/, '');
		this.apiKey = (apiKey || '').trim();
		this.fetch = fetchFn ?? requestUrl;
	}

	updateConfig(serverUrl: string, apiKey: string) {
		this.serverUrl = (serverUrl || '').trim().replace(/\/+$/, '');
		this.apiKey = (apiKey || '').trim();
	}

	isConfigured(): boolean {
		return !!this.serverUrl && !!this.apiKey;
	}

	getServerUrl(): string {
		return this.serverUrl;
	}

	getThumbnailUrl(assetId: string): string {
		if (!this.serverUrl || !assetId) return '';
		const base = `${this.serverUrl}/api/assets/${encodeURIComponent(
			assetId
		)}/thumbnail`;
		return this.apiKey
			? `${base}?size=thumbnail&apiKey=${encodeURIComponent(this.apiKey)}`
			: `${base}?size=thumbnail`;
	}

	getFullsizeUrl(assetId: string): string {
		if (!this.serverUrl || !assetId) return '';
		const base = `${this.serverUrl}/api/assets/${encodeURIComponent(
			assetId
		)}/original`;
		return this.apiKey
			? `${base}?apiKey=${encodeURIComponent(this.apiKey)}`
			: base;
	}

	getPreviewUrl(assetId: string): string {
		if (!this.serverUrl || !assetId) return '';
		const base = `${this.serverUrl}/api/assets/${encodeURIComponent(
			assetId
		)}/thumbnail`;
		return this.apiKey
			? `${base}?size=preview&apiKey=${encodeURIComponent(this.apiKey)}`
			: `${base}?size=preview`;
	}

	private async doFetch(
		url: string,
		method = 'GET',
		body?: string
	): Promise<RequestUrlResponse> {
		if (!this.serverUrl && !this.apiKey) {
			throw new Error(
				'Immich is not configured: server URL and API key are both missing. Open Settings → Immich Memories and set your Immich server URL (e.g. https://immich.example.com) and API key.'
			);
		}
		if (!this.serverUrl) {
			throw new Error(
				'Immich server URL is not set. Configure it in Settings → Immich Memories. Example: https://immich.example.com (no trailing slash, no /api suffix).'
			);
		}
		if (!this.apiKey) {
			throw new Error(
				'Immich API key is not set. Configure it in Settings → Immich Memories. Create a key in Immich → Account Settings → API Keys.'
			);
		}

		const headers: Record<string, string> = {
			'x-api-key': this.apiKey,
		};
		if (body) {
			headers['Content-Type'] = 'application/json';
		}

		try {
			return await this.fetch({
				url,
				method,
				headers,
				body,
				throw: false,
			});
		} catch (e: unknown) {
			const cause = e instanceof Error ? e.message : String(e);
			throw new Error(
				`Failed to connect to Immich server at ${this.serverUrl}. Network error: ${cause}. ` +
					`Check that the server URL is correct (e.g. https://immich.example.com, no trailing /api suffix), ` +
					`that the Immich server is running and reachable from this device, ` +
					`and that your API key is valid. If you use a self-signed certificate, ensure Obsidian/Electron trusts it. ` +
					`Tried endpoint: ${url}`
			);
		}
	}

	private extractAssetsFromResponse(json: unknown): ImmichAsset[] {
		if (!json) return [];
		if (Array.isArray(json)) {
			return json as ImmichAsset[];
		}
		if (typeof json === 'object' && json !== null) {
			const obj = json as Record<string, unknown>;
			if (obj.assets !== undefined) {
				const assets = obj.assets as unknown;
				if (Array.isArray(assets)) return assets as ImmichAsset[];
				if (typeof assets === 'object' && assets !== null) {
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

	async searchByDateRangeTaken(
		takenAfter: string,
		takenBefore: string
	): Promise<ImmichPhoto[]> {
		const endpoint = `${this.serverUrl}/api/search/metadata`;

		const payload = {
			takenAfter,
			takenBefore,
			size: 1000,
		};

		const res: RequestUrlResponse = await this.doFetch(
			endpoint,
			'POST',
			JSON.stringify(payload)
		);

		if (res.status >= 200 && res.status < 300) {
			const assets = this.extractAssetsFromResponse(res.json);
			return this.mapAssetsToPhotos(assets);
		}

		// Handle specific status codes explicitly
		if (res.status === 401) {
			throw new Error(
				`Immich authentication failed (401) at ${this.serverUrl}. ` +
					`Your API key is invalid or expired. Generate a new key in Immich → Account Settings → API Keys and update it in Settings → Immich Memories. ` +
					`Server response: ${extractErrorBody(res)}`
			);
		}
		if (res.status === 403) {
			throw new Error(
				`Immich access forbidden (403) at ${this.serverUrl}. ` +
					`The API key does not have permission to search assets. Check the key's permissions in Immich. ` +
					`Server response: ${extractErrorBody(res)}`
			);
		}
		if (res.status === 404 || res.status === 400) {
			// Try fallback with simpler payload
			const fallbackPayload = { takenAfter, takenBefore };
			let fallbackRes: RequestUrlResponse | null = null;
			try {
				fallbackRes = await this.doFetch(
					endpoint,
					'POST',
					JSON.stringify(fallbackPayload)
				);
				if (fallbackRes.status >= 200 && fallbackRes.status < 300) {
					const assets = this.extractAssetsFromResponse(
						fallbackRes.json
					);
					return this.mapAssetsToPhotos(assets);
				}
			} catch {
				void 0;
			}

			if (res.status === 404) {
				throw new Error(
					`Immich API endpoint not found (404) at ${endpoint}. ` +
						`This does NOT mean no photos were found—it means the server URL or Immich version is wrong. ` +
						`Current serverUrl setting: ${this.serverUrl}. ` +
						`Expected base URL like https://immich.example.com (no trailing /api). ` +
						`The endpoint /api/search/metadata exists in Immich v1.90+. If you run an older version, update Immich or check reverse proxy config. ` +
						`Tried searching takenAfter=${takenAfter} takenBefore=${takenBefore}. ` +
						`Server responses: primary=${extractErrorBody(
							res
						)} fallback=${
							fallbackRes
								? extractErrorBody(fallbackRes)
								: 'no fallback attempt'
						}`
				);
			}
			// 400 bad request
			throw new Error(
				`Immich search request rejected (400) at ${endpoint}. ` +
					`This usually means the date format or payload is invalid, or the server version expects different parameters. ` +
					`Tried takenAfter=${takenAfter} takenBefore=${takenBefore}. ` +
					`Server response: ${extractErrorBody(res)}`
			);
		}

		if (res.status >= 500) {
			throw new Error(
				`Immich server error (${res.status}) at ${this.serverUrl}. ` +
					`The Immich server failed to process the search. Check Immich server logs. ` +
					`Endpoint: ${endpoint} takenAfter=${takenAfter} takenBefore=${takenBefore}. ` +
					`Server response: ${extractErrorBody(res)}`
			);
		}

		// Generic non-2xx
		throw new Error(
			`Immich search failed with HTTP ${res.status} at ${
				this.serverUrl
			}${endpoint.replace(this.serverUrl, '')}. ` +
				`Endpoint: ${endpoint}. Range: ${takenAfter} → ${takenBefore}. ` +
				`Server response: ${extractErrorBody(res)}. ` +
				`Check server URL, API key, and Immich version compatibility.`
		);
	}

	private filterOutLivePhotoVideos(assets: ImmichAsset[]): ImmichAsset[] {
		// Immich links a still image (HEIC/JPEG) to its motion video (MOV)
		// via `livePhotoVideoId`. We want to keep the still and drop the
		// video component, but keep standalone videos.
		const liveVideoIds = new Set<string>();
		for (const asset of assets) {
			if (asset.livePhotoVideoId) {
				liveVideoIds.add(asset.livePhotoVideoId);
			}
		}
		if (liveVideoIds.size > 0) {
			return assets.filter((a) => !liveVideoIds.has(a.id));
		}

		// Fallback for older Immich responses or cases where livePhotoVideoId
		// is missing: HEIC live photos are often stored as IMG_1234.HEIC + IMG_1234.MOV.
		// If we see a HEIC image and a MOV video sharing the same basename, treat
		// the MOV as the live-photo motion component and drop it. This keeps
		// standalone videos (MP4, etc.) and MOVs without a matching HEIC.
		const heicBasenames = new Set<string>();
		for (const a of assets) {
			if (a.type !== 'IMAGE') continue;
			const name = a.originalFileName;
			if (!name) continue;
			const lower = name.toLowerCase();
			if (lower.endsWith('.heic') || lower.endsWith('.heif')) {
				const base = name.slice(0, name.lastIndexOf('.')).toLowerCase();
				if (base) heicBasenames.add(base);
			}
		}
		if (heicBasenames.size === 0) return assets;

		const movIdsToDrop = new Set<string>();
		for (const a of assets) {
			if (a.type !== 'VIDEO') continue;
			const name = a.originalFileName;
			if (!name) continue;
			if (!name.toLowerCase().endsWith('.mov')) continue;
			const base = name.slice(0, name.lastIndexOf('.')).toLowerCase();
			if (base && heicBasenames.has(base)) {
				movIdsToDrop.add(a.id);
			}
		}
		if (movIdsToDrop.size === 0) return assets;
		return assets.filter((a) => !movIdsToDrop.has(a.id));
	}

	private mapAssetsToPhotos(assets: ImmichAsset[]): ImmichPhoto[] {
		const withoutLiveVideos = this.filterOutLivePhotoVideos(assets);
		return withoutLiveVideos
			.filter((a) => !!a.id)
			.map((a) => ({
				assetId: a.id,
				thumbnailUrl: this.getThumbnailUrl(a.id),
				fullsizeUrl: this.getFullsizeUrl(a.id),
				takenAt:
					a.exifInfo?.dateTimeOriginal ??
					a.fileCreatedAt ??
					a.localDateTime,
				originalFileName: a.originalFileName,
				type: a.type,
				livePhotoVideoId: a.livePhotoVideoId ?? null,
			}));
	}

	async getPhotosForDate(
		dateStr: string,
		timeZone: string
	): Promise<ImmichPhoto[]> {
		const tz = normalizeTimeZone(timeZone);
		const range = getDayRangeUtc(dateStr, tz);
		if (!range) {
			throw new Error(
				`Invalid date string "${dateStr}". Expected format YYYY-MM-DD (e.g. 2023-07-15). ` +
					`Check the frontmatter field configured in Settings → Immich Memories (currently "${dateStr}").`
			);
		}
		try {
			return await this.searchByDateRangeTaken(
				range.takenAfter,
				range.takenBefore
			);
		} catch (e: unknown) {
			// Re-wrap with date context if not already explicit
			if (e instanceof Error) {
				if (
					e.message.includes('Immich') ||
					e.message.includes('Failed to connect') ||
					e.message.includes('HTTP')
				) {
					throw e;
				}
				throw new Error(
					`Failed to load Immich memories for ${dateStr} in timezone ${tz} (${range.takenAfter} → ${range.takenBefore}) from ${this.serverUrl}: ${e.message}`
				);
			}
			throw new Error(
				`Failed to load Immich memories for ${dateStr} in timezone ${tz} from ${
					this.serverUrl
				}: ${String(e)}`
			);
		}
	}
}
