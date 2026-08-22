import { App, requestUrl } from "obsidian";
import { AssetCacheRecord, ImmichSettings } from "../types";

/**
 * Filesystem cache for thumbnails and fullsize images.
 * Stores files under <vault>/.obsidian/plugins/<pluginId>/cache/assets
 * (or custom folder if configured).
 */

/** Metadata is written at most once per this window instead of once per mutation. */
const METADATA_FLUSH_DELAY_MS = 2000;

export class AssetFileCache {
	private app: App;
	private getSettings: () => ImmichSettings;
	private pluginId: string;
	private initialized = false;
	private initPromise: Promise<void> | null = null;

	private rootDir = "";
	private thumbsDir = "";
	private fullDir = "";
	private metaPath = "";

	private records: Map<string, AssetCacheRecord> = new Map();
	private totalSizeBytes = 0;

	private dirty = false;
	private flushTimer: number | null = null;
	/** Serializes metadata writes so concurrent flushes cannot interleave. */
	private writeChain: Promise<void> = Promise.resolve();

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

	/**
	 * Single-flight: concurrent callers share one promise. Without this, a
	 * codeblock rendering while onload's unawaited initialize() is still in
	 * flight starts a second loadMetadata() that resets `records` to an empty
	 * map, clobbering anything the first pass already added.
	 */
	async initialize(): Promise<void> {
		const newRoot = this.resolveRoot();

		if (this.initPromise && newRoot === this.rootDir) {
			return this.initPromise;
		}

		const rootChanged = this.initialized && newRoot !== this.rootDir;
		if (rootChanged) {
			// A flush scheduled against the old root must not land in the new one
			this.cancelPendingFlush();
		}

		this.rootDir = newRoot;
		this.thumbsDir = `${newRoot}/thumbs`;
		this.fullDir = `${newRoot}/full`;
		this.metaPath = `${newRoot}/asset-cache.json`;

		this.initPromise = this.doInitialize(!this.initialized || rootChanged);
		return this.initPromise;
	}

	private async doInitialize(needsLoad: boolean): Promise<void> {
		await this.ensureDir(this.rootDir);
		await this.ensureDir(this.thumbsDir);
		await this.ensureDir(this.fullDir);

		if (needsLoad) {
			// Reconcile only when metadata actually parsed — otherwise every
			// file on disk looks orphaned. Must finish before `initialized` is
			// set: every writer awaits initialize(), so nothing can create a
			// file that this pass would then mistake for an orphan.
			if (await this.loadMetadata()) {
				await this.removeOrphanFiles();
			}
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

	/** @returns true only when existing metadata was read and parsed. */
	private async loadMetadata(): Promise<boolean> {
		try {
			const exists = await this.adapter.exists(this.metaPath);
			if (!exists) {
				this.records = new Map();
				this.totalSizeBytes = 0;
				return false;
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
			return true;
		} catch {
			void 0;
			this.records = new Map();
			this.totalSizeBytes = 0;
			return false;
		}
	}

	/**
	 * Metadata is flushed lazily, so a crash can drop a record while its file
	 * remains on disk. Such a file is invisible to eviction and would leak
	 * forever, so reclaim it at load.
	 */
	private async removeOrphanFiles(): Promise<void> {
		const known = new Set<string>();
		for (const rec of this.records.values()) {
			if (rec.thumbnailRelativePath) known.add(rec.thumbnailRelativePath);
			if (rec.fullsizeRelativePath) known.add(rec.fullsizeRelativePath);
		}

		for (const dir of [this.thumbsDir, this.fullDir]) {
			for (const name of await this.listFiles(dir)) {
				const path = `${dir}/${name}`;
				if (known.has(path)) continue;
				try {
					await this.adapter.remove(path);
				} catch {
					void 0;
				}
			}
		}
	}

	/**
	 * Mark metadata as needing a write. Callers must never await a write on the
	 * render path: JSON.stringify of the whole record set runs synchronously on
	 * the caller's stack, so doing it per asset stalls first paint.
	 */
	private markDirty(): void {
		this.dirty = true;
		if (this.flushTimer !== null) return;
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			void this.flush();
		}, METADATA_FLUSH_DELAY_MS);
	}

	private cancelPendingFlush(): void {
		if (this.flushTimer !== null) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.dirty = false;
	}

	private async flush(): Promise<void> {
		if (!this.dirty) return this.writeChain;
		this.cancelPendingFlush();

		const payload = JSON.stringify(Array.from(this.records.values()));
		const path = this.metaPath;
		this.writeChain = this.writeChain.then(async () => {
			try {
				await this.adapter.write(path, payload);
			} catch {
				void 0;
				// ignore write errors
			}
		});
		return this.writeChain;
	}

	/** Force a write and wait for it. Call on plugin unload/quit. */
	async flushNow(): Promise<void> {
		await this.flush();
		await this.writeChain;
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
			this.markDirty();
		}
	}

	// Note: the URL getters below deliberately do NOT touch the LRU. Building a
	// URL is not accessing an asset — a gallery render builds one per photo, so
	// touching here made every original look recently-used and inverted
	// eviction order. Real access is recorded in the ensure*Cached methods.

	getThumbnailLocalUrl(assetId: string): string | null {
		if (!this.isEnabled()) return null;
		const rec = this.records.get(assetId);
		if (!rec?.thumbnailRelativePath) return null;
		return this.getResourceUrl(rec.thumbnailRelativePath);
	}

	getFullsizeLocalUrl(assetId: string): string | null {
		if (!this.isEnabled()) return null;
		const rec = this.records.get(assetId);
		if (!rec?.fullsizeRelativePath) return null;
		return this.getResourceUrl(rec.fullsizeRelativePath);
	}

	getLocalUrl(assetId: string, type: "thumb" | "full"): string | null {
		if (type === "thumb") return this.getThumbnailLocalUrl(assetId);
		return this.getFullsizeLocalUrl(assetId);
	}

	/**
	 * @param deferMaintenance skip the metadata flush and size enforcement so a
	 * batch caller can do both once at the end instead of per asset.
	 */
	async ensureThumbnailCached(
		assetId: string,
		remoteUrl: string,
		apiKey: string,
		deferMaintenance = false,
	): Promise<string | null> {
		if (!this.isEnabled()) return null;
		await this.initialize();

		const existing = this.getThumbnailLocalUrl(assetId);
		if (existing) {
			const rec = this.records.get(assetId);
			if (rec?.thumbnailRelativePath) {
				try {
					const exists = await this.adapter.exists(rec.thumbnailRelativePath);
					if (exists) {
						this.touchRecord(assetId);
						return existing;
					}
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

			this.markDirty();
			if (!deferMaintenance) await this.enforceSizeLimit();

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
					if (exists) {
						this.touchRecord(assetId);
						return existing;
					}
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

			this.markDirty();
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

		this.markDirty();
		await this.flush();
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
		// A queued flush would otherwise re-create the metadata file we delete below
		this.cancelPendingFlush();

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
		this.markDirty();
		await this.flush();
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
