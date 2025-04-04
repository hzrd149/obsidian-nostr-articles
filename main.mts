import {
  BehaviorSubject,
  bufferTime,
  combineLatest,
  debounceTime,
  filter,
  firstValueFrom,
  fromEvent,
  lastValueFrom,
  map,
  Observable,
  of,
  shareReplay,
  skip,
  Subscription,
  switchMap,
  toArray,
} from "rxjs";
import { App, Command, Notice, Plugin, PluginManifest } from "obsidian";
import { onlyEvents, RelayPool } from "applesauce-relay";
import { AccountManager } from "applesauce-accounts";
import { registerCommonAccountTypes } from "applesauce-accounts/accounts";
import { NostrConnectSigner } from "applesauce-signers/signers/nostr-connect-signer";
import {
  getDisplayName,
  getProfileContent,
  isSafeRelayURL,
} from "applesauce-core/helpers";
import { EventStore, QueryStore } from "applesauce-core";
import { EventFactory } from "applesauce-factory";
import { ActionHub } from "applesauce-actions";
import { Filter, kinds, nip19, NostrEvent } from "nostr-tools";

import PublishModal from "./src/components/PublishModal.mjs";
import { NostrWriterSettingTab } from "./src/views/SettingsView.mjs";
import NostrPluginData, {
  TNostrPluginData,
} from "./src/schema/plugin-data.mjs";
import NostrLoaders from "./src/service/loaders.mjs";
import { DEFAULT_PLUGIN_RELAYS } from "./src/const.mjs";
import NostrConnectModal from "./src/components/NostrConnectModal.mjs";
import Publisher from "./src/service/publisher.mjs";

export default class NostrArticlesPlugin extends Plugin {
  data = new BehaviorSubject<TNostrPluginData>(NostrPluginData.parse({}));

  pool = new RelayPool();
  accounts = new AccountManager<{ name?: string }>();

  events = new EventStore();
  queries = new QueryStore(this.events);

  loaders = new NostrLoaders(this.pool, this.events);

  factory = new EventFactory({ signer: this.accounts.signer });
  actions = new ActionHub(this.events, this.factory);

  private cleanup: Subscription[] = [];

  localRelay = new BehaviorSubject<string>("");
  pluginRelays = new BehaviorSubject<string[]>(DEFAULT_PLUGIN_RELAYS);
  lookupRelays = new BehaviorSubject<string[]>([]);

  /** Active users mailboxes */
  publishRelays: Observable<string[]>;
  mailboxes: Observable<{ inboxes: string[]; outboxes: string[] } | undefined>;

  /** Sub class for managing articles */
  publisher = new Publisher(this.app, this);

  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);

    // Setup account manager
    registerCommonAccountTypes(this.accounts);

    // Setup default connection method
    NostrConnectSigner.subscriptionMethod = (
      filters: Filter[],
      relays: string[],
    ) => this.pool.req(relays, filters).pipe(onlyEvents());

    // Setup default publish method
    NostrConnectSigner.publishMethod = async (
      event: NostrEvent,
      relays: string[],
    ) => {
      lastValueFrom(this.pool.event(relays, event).pipe(toArray()));
    };

    // Setup computed values
    this.mailboxes = this.accounts.active$.pipe(
      switchMap((account) =>
        account ? this.queries.mailboxes(account.pubkey) : of(undefined),
      ),
    );
    this.publishRelays = combineLatest([
      this.pluginRelays,
      this.localRelay,
      this.mailboxes,
    ]).pipe(
      map(([pluginRelays, localRelay, mailboxes]) =>
        [localRelay, ...pluginRelays, ...(mailboxes?.outboxes ?? [])].filter(
          isSafeRelayURL,
        ),
      ),
      // share latest value and make sync
      shareReplay(1),
    );
  }

  async onload() {
    // Load plugin settings
    const data = NostrPluginData.parse((await this.loadData()) ?? {});
    this.data.next(data);

    // load settings
    this.lookupRelays.next(data.lookupRelays);
    this.pluginRelays.next(data.pluginRelays);
    this.localRelay.next(data.localRelay ?? "");

    // Load accounts
    this.accounts.fromJSON(data.accounts);
    if (data.active)
      try {
        this.accounts.setActive(data.active);
      } catch (err) {}

    // Start loaders
    this.loaders.start();

    // Start the plugin lifecycle
    this.lifecycle();

    // Setup views
    this.addSettingTab(new NostrWriterSettingTab(this.app, this));

    this.addCommand({
      id: "publish-article",
      name: "Publish article",
      callback: async () => {
        await this.checkAndPublish();
      },
    });

    // this.addCommand({
    //   id: "open-article",
    //   name: "Open article",
    //   icon: "external-link",
    //   callback: async () => {
    //     await this.checkAndPublish();
    //   },
    // });

    this.addCommand({
      id: "show-relays",
      name: "Show connected relays",
      callback: async () => {
        for (let [url, relay] of this.pool.relays) {
          if (relay.connected) new Notice(`Connected to ${relay.url}`);
        }
      },
    });

    this.addCommand({
      id: "connect-nostr-account",
      name: "Connect nostr account",
      callback: () => this.connectAccount(),
    });

    this.addCommand({
      id: "account-pubkey",
      name: "Show active account pubkey",
      callback: async () => {
        if (!this.accounts.active) {
          new Notice("No active account");
        } else {
          new Notice(
            `Public Key: ${nip19.npubEncode(this.accounts.active?.pubkey)}`,
          );
        }
      },
    });
  }

  onunload(): void {
    // Save accounts
    this.updateData({
      accounts: this.accounts.toJSON(),
      active: this.accounts.active?.id,
    });

    // Stop all subscriptions
    for (const sub of this.cleanup) sub.unsubscribe();
    this.cleanup = [];

    // Stop loaders
    this.loaders.stop();
  }

  private lifecycle() {
    this.lifecycleSavePluginData();
    this.switchAccountCommands();
    this.lifecycleUserNotify();

    // Set loaders lookup relays when they change
    this.cleanup.push(
      this.lookupRelays.subscribe((relays) =>
        this.loaders.setLookupRelays(relays),
      ),
    );

    // Load profiles for all accounts
    this.cleanup.push(
      combineLatest([this.accounts.accounts$, this.publishRelays]).subscribe(
        ([accounts, relays]) => {
          for (const account of accounts) {
            console.log(`Loading events for ${account.pubkey}`);

            this.loaders.replaceable.next({
              pubkey: account.pubkey,
              kind: kinds.Metadata,
              relays,
            });
            this.loaders.replaceable.next({
              pubkey: account.pubkey,
              kind: kinds.RelayList,
              relays,
            });
          }
        },
      ),
    );

    // Update account names when profiles are loaded
    this.events.filters({ kinds: [kinds.Metadata] }).subscribe((event) => {
      const account = this.accounts.getAccountForPubkey(event.pubkey);

      if (account) {
        try {
          const profile = getProfileContent(event);

          const name = getDisplayName(profile);
          console.log(`Updating account name for ${account.pubkey}`, name);

          account.metadata = { name };

          // Save accounts
          this.updateData({ accounts: this.accounts.toJSON() });
        } catch (error) {}
      }
    });

    // Load the article event from nostr when a file is opened
    this.registerEvent(
      this.app.workspace.on("file-open", async (file) => {
        if (file && file.extension === "md") {
          const pointer = this.publisher.getArticleNostrAddress(file);

          // If the file is published as an article try to load it
          if (pointer) {
            const relays = await firstValueFrom(this.publishRelays);
            this.loaders.replaceable.next({
              ...pointer,
              relays,
            });
          }
        }
      }),
    );
  }

  /** Save plugin data when it changes */
  private lifecycleSavePluginData() {
    // Persist data when it changes
    this.cleanup.push(
      this.data
        .pipe(skip(1), debounceTime(1000))
        .subscribe((data) => this.saveData(data)),
    );

    // Update data when accounts change
    this.cleanup.push(
      this.accounts.accounts$.subscribe(() =>
        this.updateData({ accounts: this.accounts.toJSON() }),
      ),
    );

    this.cleanup.push(
      this.accounts.active$.subscribe((account) =>
        this.updateData({ active: account?.id }),
      ),
    );

    this.cleanup.push(
      this.pluginRelays.subscribe((relays) =>
        this.updateData({ pluginRelays: relays }),
      ),
    );
    this.cleanup.push(
      this.lookupRelays.subscribe((relays) =>
        this.updateData({ lookupRelays: relays }),
      ),
    );
    this.cleanup.push(
      this.localRelay.subscribe((relay) =>
        this.updateData({ localRelay: relay }),
      ),
    );
  }

  private switchAccountCommands() {
    let commands = new Map<string, Command>();

    this.cleanup.push(
      this.accounts.accounts$.subscribe((accounts) => {
        for (const account of accounts) {
          const command = commands.get(account.id);

          if (!command) {
            // create command
            commands.set(
              account.id,
              this.addCommand({
                id: `switch-account-${account.id}`,
                name: `Switch to ${account.metadata?.name || account.pubkey.slice(0, 8)}`,
                callback: () => this.accounts.setActive(account),
              }),
            );
          } else if (
            account.metadata?.name &&
            !command.name.contains(account.metadata?.name)
          ) {
            // Remove old command
            this.removeCommand(command.id);

            // Create new command
            commands.set(
              account.id,
              this.addCommand({
                id: `switch-account-${account.id}`,
                name: `Switch to ${account.metadata.name}`,
                callback: () => this.accounts.setActive(account),
              }),
            );
          }
        }
      }),
    );
  }

  private lifecycleUserNotify() {
    // notify when active account changes
    this.cleanup.push(
      this.accounts.active$.pipe(skip(1)).subscribe((account) => {
        if (account)
          new Notice(
            `Switched to ${account.metadata?.name || account.pubkey.slice(0, 8)}`,
          );
        else new Notice("No nostr account");
      }),
    );

    // Notify when mailboxes are loaded
    this.cleanup.push(
      this.mailboxes.subscribe((mailboxes) => {
        if (mailboxes) new Notice(`Found ${mailboxes.inboxes.length} relays`);
      }),
    );

    // Notify the user when articles events are loaded
    this.cleanup.push(
      this.accounts.active$
        .pipe(
          filter((a) => a !== undefined),
          switchMap((account) =>
            this.events.filters({
              authors: [account!.pubkey],
              kinds: [kinds.LongFormArticle],
            }),
          ),
          bufferTime(1000),
          filter((events) => events.length > 0),
        )
        .subscribe((events) => {
          new Notice(`Loaded ${events.length} articles`);
        }),
    );
  }

  private updateData(data: Partial<TNostrPluginData>) {
    this.data.next(NostrPluginData.parse({ ...this.data.value, ...data }));
  }

  async checkAndPublish() {
    if (!this.accounts.active) {
      new Notice(`🔑 Please add a nostr account first before publishing.`);
      return;
    }

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      const fileContent = await this.app.vault.read(activeFile);
      if (fileContent.length === 0) {
        new Notice("❌ The note is empty and cannot be published.");
        return;
      }

      new PublishModal(this.app, activeFile, this).open();
    } else {
      new Notice("❗️ No note is currently active. Click into a note.");
    }
  }

  connectAccount() {
    return new Promise<void>((resolve) => {
      new NostrConnectModal(this.app, (account) => {
        this.accounts.addAccount(account);
        this.accounts.setActive(account);

        new Notice(`Account connected`);
        resolve();
      }).open();
    });
  }
}
