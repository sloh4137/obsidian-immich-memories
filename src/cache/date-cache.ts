import { App } from "obsidian";
import { DateCacheEntry, ImmichSettings } from "../types";
import { normalizeTimeZone } from "../immich/date-utils";

/**
 * Cache mapping calendar date + timezone to list of assetIds.
 * Stores entries with lastSearched timestamp for cleanup.
 */

/** Entries are written at most once per this window instead of once per read. */
const FLUSH_DELAY_MS = 2000;

export class DateAssetCache {
	private app: App;
	private getSettings: () => ImmichSettings;
	private pluginId: string;
	private initialized = false;

	private rootDir = "";
	private metaPath = "";

	private records: Map<string, DateCacheEntry> = new Map();

	private dirty = false;
	private flushTimer: number | null = null;
	private writeChain: Promise<void> = Promise.resolve();

	constructor(app: App, getSettings: () => ImmichSettings, pluginId: string) {
		this.app = app;
		this.getSettings = getSettings;
		this.pluginId = pluginId;
	}

	private resolveRoot(): string {
		const custom = this.getSettings().assetCacheFolder?.trim();
		if (custom) {
			return custom.replace(/\/+$/, "");
		}
		return `${this.app.vault.configDir}/plugins/${this.pluginId}/cache`;
	}

	async initialize(): Promise<void> {
		const newRoot = this.resolveRoot();
		const newMeta = `${newRoot}/date-cache.json`;

		if (this.initialized && newRoot === this.rootDir) {
			await this.ensureDir(this.rootDir);
			return;
		}

		const rootChanged = this.initialized && newRoot !== this.rootDir;
		if (rootChanged) {
			// A flush scheduled against the old root must not land in the new one
			this.cancelPendingFlush();
		}
		this.rootDir = newRoot;
		this.metaPath = newMeta;
		await this.ensureDir(this.rootDir);
		if (!this.initialized || rootChanged) {
			await this.load();
		}
		this.initialized = true;
	}

	private async ensureDir(path: string): Promise<void> {
		try {
			if (!(await this.app.vault.adapter.exists(path))) {
				await this.app.vault.adapter.mkdir(path);
			}
		} catch {
			void 0;
		}
	}

	private async load(): Promise<void> {
		try {
			if (!(await this.app.vault.adapter.exists(this.metaPath))) {
				this.records = new Map();
				return;
			}
			const raw = await this.app.vault.adapter.read(this.metaPath);
			const arr = JSON.parse(raw) as DateCacheEntry[];
			this.records = new Map();
			for (const e of arr) {
				if (!e.key) continue;
				this.records.set(e.key, e);
			}
		} catch {
			this.records = new Map();
		}
	}

	/**
	 * Entries can hold up to 1000 asset IDs each, so stringifying the whole set
	 * is expensive. Never do it inline on a read.
	 */
	private markDirty(): void {
		this.dirty = true;
		if (this.flushTimer !== null) return;
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			void this.save();
		}, FLUSH_DELAY_MS);
	}

	private cancelPendingFlush(): void {
		if (this.flushTimer !== null) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.dirty = false;
	}

	private async save(): Promise<void> {
		if (!this.dirty) return this.writeChain;
		this.cancelPendingFlush();

		const payload = JSON.stringify(Array.from(this.records.values()));
		const path = this.metaPath;
		this.writeChain = this.writeChain.then(async () => {
			try {
				await this.app.vault.adapter.write(path, payload);
			} catch {
				void 0;
			}
		});
		return this.writeChain;
	}

	/** Force a write and wait for it. Call on plugin unload/quit. */
	async flushNow(): Promise<void> {
		await this.save();
		await this.writeChain;
	}

	isEnabled(): boolean {
		return this.getSettings().useDateCache;
	}

	private makeKey(dateStr: string, timeZone: string): string {
		const tz = normalizeTimeZone(timeZone);
		return `${dateStr.trim()}|${tz}`;
	}

	async get(dateStr: string, timeZone: string): Promise<DateCacheEntry | null> {
		if (!this.isEnabled()) return null;
		await this.initialize();
		const key = this.makeKey(dateStr, timeZone);
		const rec = this.records.get(key) ?? null;
		if (!rec) return null;
		rec.lastSearched = Date.now();
		this.records.set(key, rec);
		this.markDirty();
		return rec;
	}

	peek(dateStr: string, timeZone: string): DateCacheEntry | null {
		if (!this.isEnabled()) return null;
		const key = this.makeKey(dateStr, timeZone);
		return this.records.get(key) ?? null;
	}

	async set(dateStr: string, timeZone: string, assetIds: string[]): Promise<void> {
		if (!this.isEnabled()) return;
		await this.initialize();
		const tz = normalizeTimeZone(timeZone);
		const key = this.makeKey(dateStr, tz);
		const now = Date.now();
		const existing = this.records.get(key);
		const entry: DateCacheEntry = {
			key,
			dateStr: dateStr.trim(),
			timeZone: tz,
			assetIds: [...assetIds],
			lastSearched: now,
			createdAt: existing?.createdAt ?? now,
		};
		this.records.set(key, entry);

		const max = this.getSettings().dateCacheMaxEntries ?? 0;
		if (max > 0 && this.records.size > max) {
			const sorted = Array.from(this.records.values()).sort((a, b) => a.lastSearched - b.lastSearched);
			const toRemove = sorted.length - max;
			for (let i = 0; i < toRemove; i++) {
				const oldest = sorted[i];
				if (oldest) this.records.delete(oldest.key);
			}
		}

		this.markDirty();
	}

	async cleanup(): Promise<number> {
		await this.initialize();
		const retentionDays = this.getSettings().dateCacheRetentionDays ?? 0;
		if (retentionDays <= 0) return 0;

		const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
		let evicted = 0;
		for (const [key, rec] of this.records) {
			if (rec.lastSearched < cutoff) {
				this.records.delete(key);
				evicted++;
			}
		}
		if (evicted > 0) {
			this.markDirty();
			await this.save();
		}
		return evicted;
	}

	async clear(): Promise<void> {
		await this.initialize();
		// A queued flush would otherwise re-create the file we delete below
		this.cancelPendingFlush();
		this.records.clear();
		try {
			if (await this.app.vault.adapter.exists(this.metaPath)) {
				await this.app.vault.adapter.remove(this.metaPath);
			}
		} catch {
			void 0;
		}
		this.markDirty();
		await this.save();
	}

	getEntryCount(): number {
		return this.records.size;
	}

	getAllEntries(): DateCacheEntry[] {
		return Array.from(this.records.values()).sort((a, b) => b.lastSearched - a.lastSearched);
	}
}
