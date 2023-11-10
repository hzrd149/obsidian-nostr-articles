import {
	App,
	ButtonComponent,
	Modal,
	Notice,
	TextAreaComponent,
	Setting,
} from "obsidian";
import NostrService from "./nostr/NostrService";
import NostrWriterPlugin from "../main";

export default class ShortFormModal extends Modal {
	plugin: NostrWriterPlugin;

	constructor(
		app: App,
		private nostrService: NostrService,
		plugin: NostrWriterPlugin
	) {
		super(app);
		this.plugin = plugin;
	}

	async onOpen() {
		let { contentEl } = this;
		contentEl.createEl("h2", { text: `Write A Short Note` });
		let summaryText = new TextAreaComponent(contentEl)
			.setPlaceholder("Write a Nostr message here...")
			.setValue("");

		summaryText.inputEl.setCssStyles({
			width: "100%",
			height: "300px",
			marginBottom: "10px",
			marginTop: "10px",
			flex: "row",
		});
		
		let selectedProfileKey = "default";
		if(this.plugin.settings.profiles.length > 0 && this.plugin.settings.multipleProfilesEnabled){
			new Setting(contentEl)
			.setName("Select Profile")
			.setDesc("Select a profile to send this note from.")
			.addDropdown((dropdown) => {
				dropdown.addOption("default", "Default");
				for (const { profileNickname } of this.plugin.settings.profiles) {
					dropdown.addOption(profileNickname, profileNickname);
				}
				dropdown.setValue("default");
				dropdown.onChange(async (value) => {
					selectedProfileKey = value;
					new Notice(`${selectedProfileKey} selected`);
					console.log(selectedProfileKey)
				});
			});
		}
		contentEl.createEl("hr");
		contentEl.createEl("p", {
			text: `Are you sure you want to send this message to Nostr?`,
		}).addClass("publish-modal-info");

		let publishButton = new ButtonComponent(contentEl)
			publishButton
			.setButtonText(this.plugin.settings.multipleProfilesEnabled ? `Confirm and Send with Selected Profile` : `Confirm and Send`)
			.setCta()
			.onClick(async () => {
				// Disable the button and change the text to show a loading state
				if (summaryText.getValue().length > 1 ) {
					publishButton.setButtonText("Sending...").setDisabled(true);
					setTimeout(async () => {
						const summary = summaryText.getValue();
						try {
							let res =
								await this.nostrService.publishShortFormNote(
									summary,
									selectedProfileKey
								);
							if (res.success) {
								setTimeout(() => {
									new Notice(
										`Successfully sent note to Nostr.`
									);
								}, 500);
								for (let relay of res.publishedRelays) {
									setTimeout(() => {
										new Notice(`✅ - Sent to ${relay}`);
									}, 500);
								}
							} else {
								new Notice(`❌ Failed to send note to Nostr.`);
							}
						} catch {
							new Notice(`❌ Failed to send note to Nostr.`);
						}
						summaryText.setValue("");
						publishButton
							.setButtonText("Confirm and Publish")
							.setDisabled(false);

						this.close();
					}, 3000);
				} else {
					new Notice(`Please enter text to publish to Nostr`);
				}
			});

		contentEl.classList.add("short-form-modal-content");
		publishButton.buttonEl.classList.add("short-form-modal-button");
		summaryText.inputEl.classList.add("short-form-modal-input");
	}
}
