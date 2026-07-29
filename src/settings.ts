import { App, PluginSettingTab, Setting } from "obsidian";
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

		new Setting(containerEl).setName("Usage").setHeading();

		const help = containerEl.createDiv({ cls: "immich-memories-settings-help" });
		help.createEl("p", {
			text: "Add a codeblock to any note with frontmatter containing your date field.",
		});
		help.createEl("pre", {
			text: `---\ndate: 2023-07-15\ntimezone: America/New_York\n---`,
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
