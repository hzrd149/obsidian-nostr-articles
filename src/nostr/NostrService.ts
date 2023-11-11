import {
	Event,
	EventTemplate,
	Kind,
	Relay,
	UnsignedEvent,
	getEventHash,
	getPublicKey,
	getSignature,
	nip19,
	relayInit,
} from "nostr-tools";
import { TFile, App } from "obsidian";
import { NostrWriterPluginSettings } from "src/settings";
import { v4 as uuidv4 } from "uuid";
import NostrWriterPlugin from "main";

interface Profile {
	profileNickname: string;
	profilePrivateKey: string;
}

export default class NostrService {
	private privateKey: string;
	private profiles : Profile[];
	private multipleProfilesEnabled : boolean;
	private publicKey: string;
	private plugin: NostrWriterPlugin;
	private app: App;
	private isConnected: boolean;
	private relayURLs: string[];
	connectedRelays: Relay[];

	constructor(
		plugin: NostrWriterPlugin,
		app: App,
		settings: NostrWriterPluginSettings
	) {
		if (!settings.privateKey) {
			console.error(
				"YourPlugin requires a private key to be set in the settings."
			);
			return;
		}

		if(settings.multipleProfilesEnabled){
			console.log("multiple profiles enabled")
			this.profiles = settings.profiles;
			this.multipleProfilesEnabled = true;
		}
		this.plugin = plugin;
		this.app = app;
		this.privateKey = this.convertKeyToHex(settings.privateKey);
		this.publicKey = getPublicKey(this.privateKey);
		this.relayURLs = [];
		if (!settings.relayURLs) {
			console.error(
				"YourPlugin requires a list of relay urls to be set in the settings, defaulting."
			);
			this.relayURLs = [
				"wss://nos.lol ",
				"wss://relay.damus.io",
				"wss://relay.nostr.band",
				"wss://relayable.org",
				"wss://nostr.rocks",
				"wss://nostr.fmt.wiz.biz",
			];
		} else {
			for (let url of settings.relayURLs) {
				if (this.isValidURL(url)) {
					this.relayURLs.push(url);
				}
			}
		}
		this.connectToRelays();
	}

	async connectToRelays() {
		this.refreshRelayUrls();
		this.connectedRelays = [];
		let connectionPromises = this.relayURLs.map((url) => {
			return new Promise<Relay | null>((resolve) => {
				console.log(`Initializing NostrService. with relay: ${url}`);
				let relayAttempt = relayInit(url);

				const timeout = setTimeout(() => {
					console.log("Connection time out!!");
					resolve(null);
				}, 10000);

				relayAttempt.on("connect", () => {
					clearTimeout(timeout);
					console.log(`connected to ${relayAttempt.url}`);
					this.connectedRelays.push(relayAttempt);
					resolve(relayAttempt);
				});

				const handleFailure = () => {
					clearTimeout(timeout);
					console.log(`failed to connect to ${url}`);
					console.log("Removing ...");
					this.connectedRelays.remove(relayAttempt);
					this.updateStatusBar();
					resolve(null);
				};

				relayAttempt.on("disconnect", handleFailure);
				relayAttempt.on("error", handleFailure);

				try {
					relayAttempt.connect();
				} catch (error) {
					console.log(error);
					resolve(null);
				}
			});
		});

		Promise.all(connectionPromises).then(() => {
			console.log(
				`Connected to ${this.connectedRelays.length} / ${this.relayURLs.length} relays`
			);
			this.updateStatusBar();
			if (this.connectedRelays.length > 0) {
				this.isConnected = true;
			}
		});
	}

	updateStatusBar = () => {
		if (this.connectedRelays.length === 0) {
			this.plugin.statusBar?.setText("Nostr 🌚");
			this.isConnected = false;
		} else {
			this.plugin.statusBar?.setText(
				`Nostr 🟣 ${this.connectedRelays.length} / ${this.relayURLs.length} relays.`
			);
		}
	};

	refreshRelayUrls() {
		this.relayURLs = [];
		if (!this.plugin.settings.relayURLs) {
			console.error(
				"YourPlugin requires a list of relay urls to be set in the settings, defaulting to Damus."
			);
			this.relayURLs = [
				"wss://nos.lol ",
				"wss://relay.damus.io",
				"wss://relay.nostr.band",
				"wss://relayable.org",
				"wss://nostr.fmt.wiz.biz",
			];
		} else {
			for (let url of this.plugin.settings.relayURLs) {
				if (this.isValidURL(url)) {
					this.relayURLs.push(url);
				}
			}
		}
	}

	getRelayInfo(relayUrl: string): boolean {
		let connected: boolean = false;
		for (let r of this.connectedRelays) {
			if (r.url == relayUrl) {
				connected = true;
			}
		}
		return connected;
	}

	public getConnectionStatus(): boolean {
		return this.isConnected;
	}

	public getPublicKey(): string {
		return this.publicKey;
	}

	async publishShortFormNote(message: string, profileNickname: string): Promise<{ success: boolean; publishedRelays: string[] }> {
		console.log(`Sending a short form note to Nostr...`);
		let profilePrivateKey = this.privateKey;
		let profilePublicKey = this.publicKey;
		if (profileNickname !== "default" && this.multipleProfilesEnabled) {
			console.log("recieved non-default profile: " + profileNickname);
			for (const { profileNickname: nickname, profilePrivateKey: key } of this.profiles) {
				if (profileNickname === nickname) {
					profilePrivateKey = this.convertKeyToHex(key);
					profilePublicKey = getPublicKey(profilePrivateKey);
				}
			}
		}
		if (message) {
			let uuid: any = uuidv4().substr(0, 8);
			let tags: any = [["d", uuid]];
			let eventTemplate: EventTemplate<Kind.Text> = {
				kind: 1,
				created_at: Math.floor(Date.now() / 1000),
				tags: tags,
				content: message,
			};
			console.log(eventTemplate);
			let event: UnsignedEvent<Kind.Text> = {
				...eventTemplate,
				pubkey: profilePublicKey,
			};

			let eventHash = getEventHash(event);

			let finalEvent: Event<Kind.Text> = {
				...event,
				id: eventHash,
				sig: getSignature(event, profilePrivateKey),
			};
			return this.publishToRelays<Kind.Text>(finalEvent, "","");
		} else {
			console.error("No message to publish");
			return { success: false, publishedRelays: [] };
		}
	}

	async publishNote(
		fileContent: string,
		activeFile: TFile,
		summary: string,
		imageUrl: string,
		title: string,
		userSelectedTags: string[],
		profileNickname: string
	): Promise<{ success: boolean; publishedRelays: string[] }> {
		console.log(`Publishing your note to Nostr...`);

		let profilePrivateKey = this.privateKey;
		let profilePublicKey = this.publicKey;
		if (profileNickname !== "default" && this.multipleProfilesEnabled) {
			console.log("recieved non-default profile: " + profileNickname);
			for (const { profileNickname: nickname, profilePrivateKey: key } of this.profiles) {
				if (profileNickname === nickname) {
					profilePrivateKey = this.convertKeyToHex(key);
					profilePublicKey = getPublicKey(profilePrivateKey);
				}
			}
		}
		if (fileContent) {
			let uuid: any = uuidv4().substr(0, 8);
			let tags: any = [["d", uuid]];

			if (summary) {
				tags.push(["summary", summary]);
			}

			if (imageUrl) {
				tags.push(["image", imageUrl]);
			}

			let timestamp = Math.floor(Date.now() / 1000);
			tags.push(["published_at", timestamp.toString()]);

			if (userSelectedTags.length > 0) {
				for (const tag of userSelectedTags) {
					tags.push(["t", tag]);
				}
			}

			if (title) {
				tags.push(["title", title]);
			} else {
				const noteTitle = activeFile.basename;
				tags.push(["title", noteTitle]);
			}
			let eventTemplate: EventTemplate<Kind.Article> = {
				kind: 30023,
				created_at: timestamp,
				tags: tags,
				content: fileContent,
			};

			let event: UnsignedEvent<Kind.Article> = {
				...eventTemplate,
				pubkey: profilePublicKey,
			};

			let eventHash = getEventHash(event);

			let finalEvent: Event<Kind.Article> = {
				...event,
				id: eventHash,
				sig: getSignature(event, profilePrivateKey),
			};

			return this.publishToRelays<Kind.Article>(
				finalEvent,
				activeFile.path,
				profileNickname
			);
		} else {
			console.error("No message to publish");
			return { success: false, publishedRelays: [] };
		}
	}

	async publishToRelays<T extends Kind>(
		finalEvent: Event<T>,
		filePath: string,
		profileNickname: string
	): Promise<{ success: boolean; publishedRelays: string[] }> {
		try {
			let publishingPromises = this.connectedRelays.map((relay) => {
				return new Promise<{ success: boolean; url?: string }>(
					(resolve) => {
						const timeout = setTimeout(() => {
							console.log(`Publishing to ${relay.url} timed out`);
							resolve({ success: false });
						}, 5000);

						if (relay.status === 1) {
							console.log(`Publishing to.. ${relay.url}`);

							let pub = relay.publish(finalEvent);

							pub?.on("ok", () => {
								clearTimeout(timeout);
								console.log(
									`Event published successfully to ${relay.url}`
								);
								resolve({ success: true, url: relay.url });
							});

							pub?.on("failed", (reason: any) => {
								clearTimeout(timeout);
								console.log(
									`Failed to publish event to ${relay.url}: ${reason}`
								);
								resolve({ success: false });
							});

							relay.on("disconnect", () => {
								clearTimeout(timeout);
								console.log(`Disconnected from ${relay.url}`);
								resolve({ success: false });
							});
						} else {
							clearTimeout(timeout);
							console.log(
								`Skipping disconnected relay: ${relay.url}`
							);
							resolve({ success: false });
						}
					}
				);
			});

			let results = await Promise.all(publishingPromises);
			let publishedRelays = results
				.filter((result) => result.success)
				.map((result) => result.url!);

			console.log(
				`Published to ${publishedRelays.length} / ${this.connectedRelays.length} relays.`
			);

			if (publishedRelays.length === 0) {
				console.log("Didn't send to any relays");
				return { success: false, publishedRelays: [] };
			} else {
				if (finalEvent.kind === Kind.Article) {
					this.savePublishedEvent(
						finalEvent,
						filePath,
						publishedRelays,
						profileNickname

					);
				}
				return { success: true, publishedRelays };
			}
		} catch (error) {
			console.error(
				"An error occurred while publishing to relays",
				error
			);
			return { success: false, publishedRelays: [] };
		}
	}

	shutdownRelays() {
		console.log("Shutting down Nostr service");
		if (this.connectedRelays.length > 0) {
			for (let r of this.connectedRelays) {
				r.close();
			}
		}
	}

	convertKeyToHex(value: string): string {
		if (value && value.startsWith("nsec")) {
			let decodedPrivateKey = nip19.decode(value);
			return decodedPrivateKey.data as string;
		}
		if (value && value.startsWith("npub")) {
			let decodedPublicKey = nip19.decode(value);
			return decodedPublicKey.data as string;
		}
		return value;
	}

	async savePublishedEvent<T extends Kind>(
		finalEvent: Event<T>,
		publishedFilePath: string,
		relays: string[],
		profileNickname: string
	) {
		const publishedDataPath = `${this.plugin.manifest.dir}/published.json`;
		let publishedEvents;
		try {
			const fileContent = await this.app.vault.adapter.read(
				publishedDataPath
			);
			publishedEvents = JSON.parse(fileContent);
		} catch (e) {
			publishedEvents = [];
		}

		const eventWithMetaData = {
			...finalEvent,
			filepath: publishedFilePath,
			publishedToRelays: relays,
			profileNickname: profileNickname,
		};
		publishedEvents.push(eventWithMetaData);
		await this.app.vault.adapter.write(
			publishedDataPath,
			JSON.stringify(publishedEvents)
		);
	}

	isValidURL(url: string) {
		try {
			new URL(url);
			return true;
		} catch (error) {
			console.log(error);
			return false;
		}
	}
}
