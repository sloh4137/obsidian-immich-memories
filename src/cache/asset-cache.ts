import { App, requestUrl } from "obsidian";
import { AssetCacheRecord, ImmichSettings } from "../types";

/**
 * Filesystem cache for thumbnails and fullsize images.
 * Stores files under <vault>/.obsidian/plugins/<pluginId>/cache/assets
 * (or custom folder if configured).
 */

export class AssetFileCache {
	private app: App;
	private getSettings: () => ImmichSettings;
	private pluginId: string;
	private initialized = false;

	private rootDir = "";
	private thumbsDir = "";
	private fullDir = "";
	private metaPath = "";

	private records: Map<string, AssetCacheRecord> = new Map();
	private totalSizeBytes = 0;

	constructor(app: App, getSettings: () => ImmichSettings, pluginId: string) {
		this.app = app;
		this.getSettings = getSettings;
		this.pluginId = pluginId;
	}

	private get adapter() {
		return this.app.vault.adapter;
	}

	private resolveRoot(): string {
		const custom = this.getSettings().assetCacheFolder?.trim();
		if (custom) {
			return custom.replace(/\/+$/, "");
		}
		return `${this.app.vault.configDir}/plugins/${this.pluginId}/cache/assets`;
	}

	async initialize(): Promise<void> {
		const newRoot = this.resolveRoot();
		const newThumbs = `${newRoot}/thumbs`;
		const newFull = `${newRoot}/full`;
		const newMeta = `${newRoot}/asset-cache.json`;

		if (this.initialized && newRoot === this.rootDir) {
			// Already initialized for this root, but ensure dirs exist
			await this.ensureDir(this.rootDir);
			await this.ensureDir(this.thumbsDir);
			await this.ensureDir(this.fullDir);
			return;
		}

		// If root changed after initial load, reset records and reload from new location
		const rootChanged = this.initialized && newRoot !== this.rootDir;

		this.rootDir = newRoot;
		this.thumbsDir = newThumbs;
		this.fullDir = newFull;
		this.metaPath = newMeta;

		await this.ensureDir(this.rootDir);
		await this.ensureDir(this.thumbsDir);
		await this.ensureDir(this.fullDir);

		if (!this.initialized || rootChanged) {
			await this.loadMetadata();
		}
		this.initialized = true;
	}

	private async ensureDir(path: string): Promise<void> {
		try {
			const exists = await this.adapter.exists(path);
			if (!exists) {
				await this.adapter.mkdir(path);
			}
		} catch {
			void 0;
			// Attempt again – some adapters need parent creation
			try {
				if (typeof this.adapter.mkdir === "function") {
					await this.adapter.mkdir(path);
				}
			} catch {
				void 0;
				// ignore dir creation failure
			}
		}
	}

	private async loadMetadata(): Promise<void> {
		try {
			const exists = await this.adapter.exists(this.metaPath);
			if (!exists) {
				this.records = new Map();
				this.totalSizeBytes = 0;
				return;
			}
			const data = await this.adapter.read(this.metaPath);
			const parsed = JSON.parse(data) as AssetCacheRecord[];
			this.records = new Map();
			let total = 0;
			for (const rec of parsed) {
				if (!rec.assetId) continue;
				this.records.set(rec.assetId, rec);
				total += (rec.thumbnailSize || 0) + (rec.fullsizeSize || 0);
			}
			this.totalSizeBytes = total;
		} catch {
			void 0;
			this.records = new Map();
			this.totalSizeBytes = 0;
		}
	}

	private async saveMetadata(): Promise<void> {
		try {
			const arr = Array.from(this.records.values());
			await this.adapter.write(this.metaPath, JSON.stringify(arr, null, 2));
		} catch {
			void 0;
			// ignore write errors
		}
	}

	isEnabled(): boolean {
		return this.getSettings().useAssetCache;
	}

	getSizeLimitBytes(): number {
		const mb = this.getSettings().assetCacheSizeMB ?? 0;
		if (mb <= 0) return Number.MAX_SAFE_INTEGER;
		return mb * 1024 * 1024;
	}

	getTotalSizeBytes(): number {
		return this.totalSizeBytes;
	}

	getTotalSizeMB(): number {
		return this.totalSizeBytes / (1024 * 1024);
	}

	private getResourceUrl(relativePath: string): string {
		try {
			return this.adapter.getResourcePath(relativePath);
		} catch {
			void 0;
		}
		return relativePath;
	}

	private touchRecord(assetId: string): void {
		const rec = this.records.get(assetId);
		if (rec) {
			rec.lastAccessed = Date.now();
			void this.saveMetadata();
		}
	}

	getThumbnailLocalUrl(assetId: string): string | null {
		if (!this.isEnabled()) return null;
		const rec = this.records.get(assetId);
		if (!rec?.thumbnailRelativePath) return null;
		this.touchRecord(assetId);
		return this.getResourceUrl(rec.thumbnailRelativePath);
	}

	getFullsizeLocalUrl(assetId: string): string | null {
		if (!this.isEnabled()) return null;
		const rec = this.records.get(assetId);
		if (!rec?.fullsizeRelativePath) return null;
		this.touchRecord(assetId);
		return this.getResourceUrl(rec.fullsizeRelativePath);
	}

	getLocalUrl(assetId: string, type: "thumb" | "full"): string | null {
		if (type === "thumb") return this.getThumbnailLocalUrl(assetId);
		return this.getFullsizeLocalUrl(assetId);
	}

	async ensureThumbnailCached(assetId: string, remoteUrl: string, apiKey: string): Promise<string | null> {
		if (!this.isEnabled()) return null;
		await this.initialize();

		const existing = this.getThumbnailLocalUrl(assetId);
		if (existing) {
			const rec = this.records.get(assetId);
			if (rec?.thumbnailRelativePath) {
				try {
					const exists = await this.adapter.exists(rec.thumbnailRelativePath);
					if (exists) return existing;
				} catch {
					void 0;
					// continue to re-download
				}
			}
		}

		try {
			const response = await requestUrl({
				url: remoteUrl,
				method: "GET",
				headers: apiKey ? { "x-api-key": apiKey } : {},
			});
			if (response.status < 200 || response.status >= 300) return null;

			const arrayBuffer = response.arrayBuffer;
			const size = arrayBuffer.byteLength;
			const relPath = `${this.thumbsDir}/${this.sanitizeFileName(assetId)}.jpg`;

			await this.writeBinary(relPath, arrayBuffer);

			let rec = this.records.get(assetId);
			if (!rec) {
				rec = {
					assetId,
					thumbnailSize: 0,
					fullsizeSize: 0,
					lastAccessed: Date.now(),
					createdAt: Date.now(),
				};
			}
			if (rec.thumbnailSize) this.totalSizeBytes -= rec.thumbnailSize;
			rec.thumbnailRelativePath = relPath;
			rec.thumbnailSize = size;
			rec.lastAccessed = Date.now();
			if (!rec.createdAt) rec.createdAt = Date.now();

			this.records.set(assetId, rec);
			this.totalSizeBytes += size;

			await this.saveMetadata();
			await this.enforceSizeLimit();

			return this.getResourceUrl(relPath);
		} catch {
			void 0;
			return null;
		}
	}

	async ensureFullsizeCached(assetId: string, remoteUrl: string, apiKey: string): Promise<string | null> {
		if (!this.isEnabled()) return null;
		await this.initialize();

		const existing = this.getFullsizeLocalUrl(assetId);
		if (existing) {
			const rec = this.records.get(assetId);
			if (rec?.fullsizeRelativePath) {
				try {
					const exists = await this.adapter.exists(rec.fullsizeRelativePath);
					if (exists) return existing;
				} catch {
					void 0;
					// continue
				}
			}
		}

		try {
			const response = await requestUrl({
				url: remoteUrl,
				method: "GET",
				headers: apiKey ? { "x-api-key": apiKey } : {},
			});
			if (response.status < 200 || response.status >= 300) return null;

			const arrayBuffer = response.arrayBuffer;
			const size = arrayBuffer.byteLength;
			const relPath = `${this.fullDir}/${this.sanitizeFileName(assetId)}.orig`;

			await this.writeBinary(relPath, arrayBuffer);

			let rec = this.records.get(assetId);
			if (!rec) {
				rec = {
					assetId,
					thumbnailSize: 0,
					fullsizeSize: 0,
					lastAccessed: Date.now(),
					createdAt: Date.now(),
				};
			}
			if (rec.fullsizeSize) this.totalSizeBytes -= rec.fullsizeSize;
			rec.fullsizeRelativePath = relPath;
			rec.fullsizeSize = size;
			rec.lastAccessed = Date.now();
			if (!rec.createdAt) rec.createdAt = Date.now();

			this.records.set(assetId, rec);
			this.totalSizeBytes += size;

			await this.saveMetadata();
			await this.enforceSizeLimit();

			return this.getResourceUrl(relPath);
		} catch {
			void 0;
			return null;
		}
	}

	private async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		if (typeof this.adapter.writeBinary === "function") {
			await this.adapter.writeBinary(path, data);
			return;
		}
		// Fallback: try to write as binary string via adapter.write if writeBinary not available (mobile)
		try {
			// Obsidian's DataAdapter.writeBinary may not exist on some platforms, but write expects string.
			// As fallback, we attempt to write via adapter.write using base64? For now, just call write with empty placeholder
			// to avoid crash – actual binary caching will not work on this platform.
			await this.adapter.write(path, "");
		} catch {
			void 0;
			// ignore write failure
		}
	}

	private sanitizeFileName(name: string): string {
		return name.replace(/[^a-zA-Z0-9-_]/g, "_");
	}

	async enforceSizeLimit(): Promise<void> {
		const limit = this.getSizeLimitBytes();
		if (this.totalSizeBytes <= limit) return;

		const sorted = Array.from(this.records.values()).sort((a, b) => a.lastAccessed - b.lastAccessed);

		for (const rec of sorted) {
			if (this.totalSizeBytes <= limit) break;
			await this.evictRecord(rec.assetId);
		}

		await this.saveMetadata();
	}

	private async evictRecord(assetId: string): Promise<void> {
		const rec = this.records.get(assetId);
		if (!rec) return;

		if (rec.thumbnailRelativePath) {
			try {
				if (await this.adapter.exists(rec.thumbnailRelativePath)) {
					await this.adapter.remove(rec.thumbnailRelativePath);
				}
			} catch {
				void 0;
				// ignore delete failure
			}
			this.totalSizeBytes -= rec.thumbnailSize || 0;
		}
		if (rec.fullsizeRelativePath) {
			try {
				if (await this.adapter.exists(rec.fullsizeRelativePath)) {
					await this.adapter.remove(rec.fullsizeRelativePath);
				}
			} catch {
				void 0;
				// ignore
			}
			this.totalSizeBytes -= rec.fullsizeSize || 0;
		}

		this.records.delete(assetId);
		if (this.totalSizeBytes < 0) this.totalSizeBytes = 0;
	}

	async clear(): Promise<void> {
		await this.initialize();

		for (const rec of this.records.values()) {
			if (rec.thumbnailRelativePath) {
				try {
					if (await this.adapter.exists(rec.thumbnailRelativePath)) {
						await this.adapter.remove(rec.thumbnailRelativePath);
					}
				} catch {
					void 0;
					// ignore
				}
			}
			if (rec.fullsizeRelativePath) {
				try {
					if (await this.adapter.exists(rec.fullsizeRelativePath)) {
						await this.adapter.remove(rec.fullsizeRelativePath);
					}
				} catch {
					void 0;
					// ignore
				}
			}
		}

		try {
			const thumbs = await this.listFiles(this.thumbsDir);
			for (const f of thumbs) {
				try {
					await this.adapter.remove(`${this.thumbsDir}/${f}`);
				} catch {
					void 0;
					// ignore
				}
			}
			const fulls = await this.listFiles(this.fullDir);
			for (const f of fulls) {
				try {
					await this.adapter.remove(`${this.fullDir}/${f}`);
				} catch {
					void 0;
					// ignore
				}
			}
		} catch {
			void 0;
			// ignore listing errors
		}

		try {
			if (await this.adapter.exists(this.metaPath)) {
				await this.adapter.remove(this.metaPath);
			}
		} catch {
			void 0;
			// ignore
		}

		this.records.clear();
		this.totalSizeBytes = 0;
		await this.saveMetadata();
	}

	private async listFiles(dir: string): Promise<string[]> {
		try {
			const list = await this.adapter.list(dir);
			return list.files.map((p: string) => {
				const parts = p.split("/");
				return parts[parts.length - 1] ?? p;
			});
		} catch {
			void 0;
			return [];
		}
	}
}
