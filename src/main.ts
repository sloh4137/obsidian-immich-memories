import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, ImmichPhoto, ImmichPublicApi, ImmichSettings } from "./types";
import { ImmichClient } from "./immich/client";
import { ImmichSettingTab } from "./settings";
import { createImmichBlockProcessor } from "./ui/renderer";
import { getDayRangeUtc } from "./immich/date-utils";

export default class ImmichMemoriesPlugin extends Plugin {
	settings!: ImmichSettings;
	private client!: ImmichClient;

	/** Public API exposed to other plugins via app.plugins.plugins['obsidian-immich-memories'].api */
	public api!: ImmichPublicApi;

	async onload() {
		await this.loadSettings();

		this.client = new ImmichClient(this.settings.immichServerUrl, this.settings.immichApiKey);

		this.api = this.buildPublicApi();

		// Expose settings tab
		this.addSettingTab(new ImmichSettingTab(this.app, this));

		// Register the codeblock renderer
		this.registerMarkdownCodeBlockProcessor("obsidian-immich-memories", createImmichBlockProcessor(this.app, () => this.client, () => this.settings));

		// Also support hyphen-less alias for convenience
		this.registerMarkdownCodeBlockProcessor("immich-memories", createImmichBlockProcessor(this.app, () => this.client, () => this.settings));
	}

	onunload() {
		// Obsidian auto cleans registered processors, but clear references
	}

	async loadSettings() {
		const loaded = (await this.loadData()) as Partial<ImmichSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
		// Ensure defaults trimmed
		this.settings.dateField = this.settings.dateField?.trim() || DEFAULT_SETTINGS.dateField;
		this.settings.timezoneField = this.settings.timezoneField?.trim() || DEFAULT_SETTINGS.timezoneField;
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
	 * Required for task: expose public API for finding photos given a date and timezone
	 * where photos will be list of structs holding assetId, thumbnail URL, and fullsize URL.
	 */
	async getPhotosForDate(dateStr: string, timeZone: string): Promise<ImmichPhoto[]> {
		return this.client.getPhotosForDate(dateStr, timeZone);
	}

	/** Alias per interface */
	async findPhotos(dateStr: string, timeZone: string): Promise<ImmichPhoto[]> {
		return this.getPhotosForDate(dateStr, timeZone);
	}

	/** Get thumbnail URL given an assetId */
	getThumbnailUrl(assetId: string): string {
		return this.client.getThumbnailUrl(assetId);
	}

	/** Get fullsize image URL given an assetId */
	getFullsizeUrl(assetId: string): string {
		return this.client.getFullsizeUrl(assetId);
	}

	/** Helper for range queries – part of public API surface */
	async searchByDateRangeTaken(takenAfter: string, takenBefore: string): Promise<ImmichPhoto[]> {
		return this.client.searchByDateRangeTaken(takenAfter, takenBefore);
	}

	/** Exposed utility: returns UTC range for debugging/other plugins */
	getDayRangeUtc(dateStr: string, timeZone: string) {
		return getDayRangeUtc(dateStr, timeZone);
	}

	private buildPublicApi(): ImmichPublicApi {
		return {
			getPhotosForDate: this.getPhotosForDate.bind(this),
			findPhotos: this.findPhotos.bind(this),
			getThumbnailUrl: this.getThumbnailUrl.bind(this),
			getFullsizeUrl: this.getFullsizeUrl.bind(this),
			searchByDateRangeTaken: this.searchByDateRangeTaken.bind(this),
		};
	}
}
