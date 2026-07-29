import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS } from "./types";
import type ImmichMemoriesPlugin from "./main";

export class ImmichSettingTab extends PluginSettingTab {
	plugin: ImmichMemoriesPlugin;

	constructor(app: App, plugin: ImmichMemoriesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Server").setHeading();

		new Setting(containerEl)
			.setName("Immich server URL")
			.setDesc("Base URL of your Immich instance, e.g. https://immich.example.com")
			.addText((text) =>
				text
					.setPlaceholder("https://immich.example.com")
					.setValue(this.plugin.settings.immichServerUrl)
					.onChange(async (value) => {
						this.plugin.settings.immichServerUrl = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Immich API key")
			.setDesc("API key from Immich account settings. Stored locally, never transmitted elsewhere.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("Paste your API key")
					.setValue(this.plugin.settings.immichApiKey)
					.onChange(async (value) => {
						this.plugin.settings.immichApiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Date field")
			.setDesc("Frontmatter field that holds the date (YYYY-MM-DD)")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.dateField)
					.setValue(this.plugin.settings.dateField)
					.onChange(async (value) => {
						this.plugin.settings.dateField = value.trim() || DEFAULT_SETTINGS.dateField;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Timezone field")
			.setDesc("Frontmatter field that holds the IANA timezone. Falls back to UTC if missing.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.timezoneField)
					.setValue(this.plugin.settings.timezoneField)
					.onChange(async (value) => {
						this.plugin.settings.timezoneField = value.trim() || DEFAULT_SETTINGS.timezoneField;
						await this.plugin.saveSettings();
					}),
			);

		/* -------- Asset Cache -------- */
		new Setting(containerEl).setName("Asset cache").setHeading();

		new Setting(containerEl)
			.setName("Enable asset cache")
			.setDesc("Cache thumbnails and fullsize images locally to reduce requests and allow offline viewing.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.useAssetCache)
					.onChange(async (value) => {
						this.plugin.settings.useAssetCache = value;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName("Asset cache size (MB)")
			.setDesc("Maximum total size for cached thumbnails and fullsize images. Least recently used files are evicted.")
			.addText((text) => {
				text.inputEl.type = "number";
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.assetCacheSizeMB))
					.setValue(String(this.plugin.settings.assetCacheSizeMB))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n >= 0) {
							this.plugin.settings.assetCacheSizeMB = n;
							await this.plugin.saveSettings();
						}
					});
				text.setDisabled(!this.plugin.settings.useAssetCache);
			});

		new Setting(containerEl)
			.setName("Asset cache folder")
			.setDesc("Optional custom vault-relative folder (e.g. ImmichCache/assets). Leave empty for default inside .obsidian/plugins folder.")
			.addText((text) =>
				text
					.setPlaceholder(".obsidian/plugins/obsidian-immich-memories/cache/assets")
					.setValue(this.plugin.settings.assetCacheFolder ?? "")
					.onChange(async (value) => {
						this.plugin.settings.assetCacheFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			)
			.descEl.createEl("div", {
				cls: "setting-item-description",
				text: `Current usage: ${this.plugin.getAssetCacheSizeMB().toFixed(2)} MB / ${this.plugin.settings.assetCacheSizeMB} MB`,
			});

		new Setting(containerEl)
			.setName("Clear asset cache")
			.setDesc("Delete all locally cached thumbnails and fullsize images.")
			.addButton((btn) =>
				btn
					.setButtonText("Clear cache")
					.setWarning()
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText("Clearing...");
						try {
							await this.plugin.clearAssetCache();
							new Notice("Asset cache cleared");
							this.display();
						} catch (e) {
							const msg = e instanceof Error ? e.message : String(e);
							new Notice(`Failed to clear asset cache: ${msg}`);
							btn.setDisabled(false);
							btn.setButtonText("Clear cache");
						}
					}),
			);

		/* -------- Date Cache -------- */
		new Setting(containerEl).setName("Date cache").setHeading();

		new Setting(containerEl)
			.setName("Enable date cache")
			.setDesc("Cache mapping from calendar date+timezone to list of assetIds to avoid re-querying Immich.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.useDateCache)
					.onChange(async (value) => {
						this.plugin.settings.useDateCache = value;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName("Date cache retention (days)")
			.setDesc("How long to keep a date entry based on its time last searched before automatic cleanup. 0 = never auto-evict.")
			.addText((text) => {
				text.inputEl.type = "number";
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.dateCacheRetentionDays))
					.setValue(String(this.plugin.settings.dateCacheRetentionDays))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n >= 0) {
							this.plugin.settings.dateCacheRetentionDays = n;
							await this.plugin.saveSettings();
						}
					});
				text.setDisabled(!this.plugin.settings.useDateCache);
			});

		new Setting(containerEl)
			.setName("Clear date cache")
			.setDesc(`Remove all cached date->assetIds mappings. ${this.plugin.dateCache ? `Currently ${this.plugin.dateCache.getEntryCount()} entries.` : ""}`)
			.addButton((btn) =>
				btn
					.setButtonText("Clear date cache")
					.setWarning()
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText("Clearing...");
						try {
							await this.plugin.clearDateCache();
							new Notice("Date cache cleared");
							this.display();
						} catch (e) {
							const msg = e instanceof Error ? e.message : String(e);
							new Notice(`Failed to clear date cache: ${msg}`);
							btn.setDisabled(false);
							btn.setButtonText("Clear date cache");
						}
					}),
			);

		new Setting(containerEl)
			.setName("Run date cleanup now")
			.setDesc("Manually evict date entries older than retention days based on time last searched.")
			.addButton((btn) =>
				btn
					.setButtonText("Run cleanup")
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText("Cleaning...");
						try {
							const evicted = await this.plugin.dateCache.cleanup();
							new Notice(`Evicted ${evicted} old date entries`);
							this.display();
						} catch (e) {
							const msg = e instanceof Error ? e.message : String(e);
							new Notice(`Cleanup failed: ${msg}`);
						} finally {
							btn.setDisabled(false);
							btn.setButtonText("Run cleanup");
						}
					}),
			);

		new Setting(containerEl).setName("Usage").setHeading();

		const help = containerEl.createDiv({ cls: "immich-memories-settings-help" });
		help.createEl("p", {
			text: "Add a codeblock to any note with frontmatter containing your date field.",
		});
		help.createEl("pre", {
			text: `---
date: 2023-07-15
timezone: America/New_York
---`,
			cls: "immich-memories-code-sample",
		});
		help.createEl("p", { text: "Then in the body:" });
		help.createEl("pre", {
			text: "```obsidian-immich-memories\n```",
			cls: "immich-memories-code-sample",
		});
		help.createEl("p", {
			text: "You can also override inside the block: date: 2024-01-02 and timezone: Europe/London.",
		});
	}
}
