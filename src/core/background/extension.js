'use strict';

/*
 * The extension uses `browser.runtime.sendMessage` function for communication
 * between different modules using the following message types:
 *
 * 1) events:
 *  - EVENT_STATE_CHANGED: The connector state is changed
 *    @param  {Object} state Connector state
 *  - EVENT_SONG_UPDATED: The current song is updated
 *    @param  {Object} data Song instance copy
 *  - EVENT_READY: The connector is injected and the controller is created
 *  - EVENT_PING: The 'ping' event to check if connector is injected
 *
 * 2) requests:
 *  - REQUEST_GET_SONG: Get now playing song
 *    @return {Object} Song instance copy
 *  - REQUEST_CORRECT_SONG: Correct song info
 *    @param  {Object} data Object contains corrected song info
 *  - REQUEST_TOGGLE_LOVE: Toggle song love status
 *    @param  {Boolean} isLoved Flag indicates song is loved
 *  - REQUEST_RESET_SONG: Reset corrected song info
 *  - REQUEST_SKIP_SONG: Ignore (don't scrobble) current song
 *  - REQUEST_AUTHENTICATE: Authenticate scrobbler
 *    @param  {String} scrobbler Scrobbler label
 */

define((require) => {
	const GA = require('service/ga');
	const Util = require('util/util');
	const Inject = require('browser/inject');
	const Options = require('storage/options');
	const Migrate = require('util/migrate');
	const browser = require('webextension-polyfill');
	const Controller = require('object/controller');
	const InjectResult = require('object/inject-result');
	const BrowserAction = require('browser/browser-action');
	const Notifications = require('browser/notifications');
	const ControllerMode = require('object/controller-mode');
	const BrowserStorage = require('storage/browser-storage');
	const ScrobbleService = require('object/scrobble-service');

	/**
	 * How many times to show auth notification.
	 *
	 * @type {Number}
	 */
	const AUTH_NOTIFICATION_DISPLAY_COUNT = 3;

	/**
	 * Current version of the extension.
	 *
	 * @type {String}
	 */
	const extVersion = browser.runtime.getManifest().version;

	/**
	 * Single controller instance for each tab with injected script.
	 * This allows us to work with tabs independently.
	 *
	 * @type {Object}
	 */
	const tabControllers = {};

	/**
	 * Array of versions have notable changes.
	 *
	 * @type {Array}
	 */
	const versionsToNotify = [];

	/**
	 * Flag for "page session" where at least single injection occurred.
	 * Used for tracking number of actually active users.
	 *
	 * @type {Boolean}
	 */
	let isActiveSession = false;

	const notificationStorage = BrowserStorage.getStorage(BrowserStorage.NOTIFICATIONS);

	const browserAction = new BrowserAction();

	/**
	 * ID of a recent active tab.
	 * @type {Number}
	 */
	let activeTabId = null;

	/**
	 * ID of a current tab.
	 * @type {Number}
	 */
	let currentTabId = null;

	/**
	 * Setup browser event listeners. Called on startup.
	 */
	function setupEventListeners() {
		try {
			browser.commands.onCommand.addListener(onCommand);
		} catch (e) {
			// Don't let the extension fail on Firefox for Android.
		}

		browser.tabs.onUpdated.addListener(onTabUpdated);
		browser.tabs.onRemoved.addListener(onTabRemoved);
		browser.tabs.onActivated.addListener((activeInfo) => {
			onTabChanged(activeInfo.tabId);
		});

		browser.runtime.onMessage.addListener(onMessage);
		browser.runtime.onConnect.addListener((port) => {
			port.onMessage.addListener((message) => {
				onPortMessage(message, port.sender);
			});
		});
	}

	/**
	 * Called when a command is executed.
	 *
	 * @param  {String} command Command ID
	 */
	async function onCommand(command) {
		const ctrl = tabControllers[activeTabId] || tabControllers[currentTabId];
		if (!ctrl) {
			return;
		}

		switch (command) {
			case 'toggle-connector':
				setConnectorState(ctrl, !ctrl.isEnabled);
				break;
			case 'love-song':
			case 'unlove-song': {
				const isLoved = command === 'love-song';

				await ctrl.toggleLove(isLoved);
				browserAction.setSongLoved(isLoved, ctrl.getCurrentSong());
				break;
			}
		}
	}

	/**
	 * Called when something sent message to background script.
	 *
	 * @param  {Object} request Message sent by the calling script
	 */
	async function onMessage(request) {
		switch (request.type) {
			case 'REQUEST_AUTHENTICATE': {
				const scrobblerLabel = request.scrobbler;
				const scrobbler = ScrobbleService.getScrobblerByLabel(scrobblerLabel);

				if (scrobbler) {
					authenticateScrobbler(scrobbler);
				}

				return;
			}

			case 'REQUEST_ACTIVE_TABID':
				return activeTabId;
		}

		const tabId = request.tabId;
		const ctrl = tabControllers[tabId];

		if (!ctrl) {
			console.warn(
				`Attempted to send event to controller for tab ${tabId}`);
			return;
		}

		switch (request.type) {
			case 'REQUEST_GET_SONG':
				return ctrl.getCurrentSong().getCloneableData();

			case 'REQUEST_CORRECT_SONG':
				ctrl.setUserSongData(request.data);
				break;

			case 'REQUEST_TOGGLE_LOVE':
				await ctrl.toggleLove(request.data.isLoved);
				return request.data.isLoved;

			case 'REQUEST_SKIP_SONG':
				ctrl.skipCurrentSong();
				break;

			case 'REQUEST_RESET_SONG':
				ctrl.resetSongData();
				break;
		}
	}

	/**
	 * Called when something sent message to background script via port.
	 *
	 * @param  {Object} message Message object
	 * @param  {Object} sender Message sender
	 */
	function onPortMessage(message, sender) {
		switch (message.type) {
			case 'EVENT_STATE_CHANGED': {
				const ctrl = tabControllers[sender.tab.id];
				if (ctrl) {
					ctrl.onStateChanged(message.data);
				}
				break;
			}
		}
	}

	/**
	 * Called when a tab is updated.
	 *
	 * @param  {Number} tabId Tab ID
	 * @param  {Object} changeInfo Object contains changes of updated tab
	 * @param  {Object} tab State of updated tab
	 */
	async function onTabUpdated(tabId, changeInfo, tab) {
		// wait for navigation to complete (this does not mean page onLoad)
		if (changeInfo.status !== 'complete') {
			return;
		}

		let result;
		try {
			result = await Inject.onTabsUpdated(tab);
		} catch (err) {
			console.warn(err.message);
			return;
		}

		switch (result.type) {
			case InjectResult.NO_MATCH: {
				unloadController(tabId);
				break;
			}

			case InjectResult.MATCHED_BUT_DISABLED:
			case InjectResult.MATCHED_AND_INJECTED: {
				unloadController(tabId);

				const enabled = result.type === InjectResult.MATCHED_AND_INJECTED;
				const ctrl = new Controller(tabId, result.connector, enabled);
				ctrl.onSongUpdated = async() => {
					const data = ctrl.getCurrentSong().getCloneableData();
					const type = 'EVENT_SONG_UPDATED';

					try {
						await browser.runtime.sendMessage({ type, data, tabId });
					} catch (e) {
						// Suppress errors
					}
				};
				ctrl.onModeChanged = () => {
					const mode = ctrl.getMode();

					if (ControllerMode.isActive(mode)) {
						activeTabId = tabId;
					}

					if (tabId === activeTabId) {
						if (currentTabId !== tabId && ControllerMode.isInactive(mode)) {
							updateBrowserAction(currentTabId);
							return;
						}

						updateBrowserAction(tabId);
					}
				};
				tabControllers[tabId] = ctrl;
				if (shouldUpdateBrowserAction(tabId)) {
					updateBrowserAction(tabId);
				}

				browser.tabs.sendMessage(tabId, { type: 'EVENT_READY' });

				GA.event('core', 'inject', result.connector.label);

				if (!isActiveSession) {
					isActiveSession = true;
					GA.pageview(`/background-injected?version=${extVersion}`);
				}
				break;
			}
		}

		updateContextMenu(tabId);
	}

	/**
	 * Called when a current tab is changed.
	 *
	 * @param  {Object} tabId Tab ID
	 */
	function onTabChanged(tabId) {
		currentTabId = tabId;

		updateContextMenu(tabId);
		if (shouldUpdateBrowserAction(tabId)) {
			updateBrowserAction(tabId);
			activeTabId = tabId;
		}
	}

	/**
	 * Called when a tab is removed.
	 *
	 * @param  {Number} removedTabId Tab ID
	 */
	async function onTabRemoved(removedTabId) {
		unloadController(removedTabId);

		const lastActiveTabId = findActiveTabId();
		if (lastActiveTabId !== -1) {
			activeTabId = lastActiveTabId;

			updateBrowserAction(activeTabId);
			updateContextMenu(activeTabId);
		} else {
			browserAction.reset();
			resetContextMenu();
		}
	}

	/**
	 * Get ID of a tab with recent active controller.
	 *
	 * @return {Number} Tab ID
	 */
	function findActiveTabId() {
		const ctrl = tabControllers[currentTabId];
		if (ctrl && ControllerMode.isActive(ctrl.mode)) {
			return currentTabId;
		}

		for (const tabId in tabControllers) {
			const mode = tabControllers[tabId].mode;
			if (ControllerMode.isActive(mode)) {
				return tabId;
			}
		}

		if (ctrl) {
			return currentTabId;
		}

		return -1;
	}

	/**
	 * Create new tab with release notes of current version.
	 * Called after update to version with notable changes.
	 */
	function openChangelogSection() {
		browser.tabs.create({ url: `https://github.com/web-scrobbler/web-scrobbler/releases/tag/v${extVersion}` });
	}

	/**
	 * Setup context menu of the browser action for a tab with given tab ID.
	 *
	 * @param  {Number} tabId Tab ID
	 */
	function updateContextMenu(tabId) {
		resetContextMenu();

		if (activeTabId !== tabId) {
			addContextMenuFor(tabId, tabControllers[activeTabId]);
		}
		addContextMenuFor(tabId, tabControllers[tabId]);

		addContextMenuItem(null, null, 'separator');
	}

	/**
	 * Remove all items from the context menu.
	 */
	function resetContextMenu() {
		browser.contextMenus.removeAll();
	}

	/**
	 * Add context menu for a given controller.
	 *
	 * @param  {Number} tabId Tab ID
	 * @param  {Object} ctrl Controller instance
	 */
	function addContextMenuFor(tabId, ctrl) {
		if (!ctrl) {
			return;
		}

		const connector = ctrl.getConnector();
		const labelId = ctrl.isEnabled ? 'menuDisableConnector' : 'menuEnableConnector';
		const newValue = !ctrl.isEnabled;
		const itemTitle = browser.i18n.getMessage(labelId, connector.label);

		addContextMenuItem(itemTitle, () => {
			setConnectorState(ctrl, newValue);
			updateContextMenu(tabId);

			if (shouldUpdateBrowserAction(tabId)) {
				updateBrowserAction(tabId);
			}
		});
	}

	/**
	 * Helper function to add item to page action context menu.
	 *
	 * @param {String} title Item title
	 * @param {Function} onclick Function that will be called on item click
	 * @param {String} [type='normal'] Item type
	 */
	function addContextMenuItem(title, onclick, type = 'normal') {
		browser.contextMenus.create({
			title, type, onclick, contexts: ['browser_action'],
		});
	}

	/**
	 * Update the browser action in context of a given tab ID.
	 *
	 * @param  {Number} tabId Tab ID
	 */
	function updateBrowserAction(tabId) {
		const ctrl = tabControllers[tabId];
		if (ctrl) {
			browserAction.update(ctrl);
		} else {
			browserAction.reset();
		}
	}

	/**
	 * Check if the browser action should be updated
	 * in context of a given tab ID.
	 *
	 * @param  {Number} tabId Tab ID
	 *
	 * @return {Boolean} Check result
	 */
	function shouldUpdateBrowserAction(tabId) {
		const activeCtrl = tabControllers[activeTabId];
		if (activeCtrl && ControllerMode.isActive(activeCtrl.mode)) {
			return false;
		}

		const ctrl = tabControllers[tabId];
		if (ctrl) {
			if (tabId !== currentTabId && ControllerMode.isInactive(ctrl.mode)) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Replace the extension version stored in local storage by current one.
	 */
	async function updateVersionInStorage() {
		const storage = BrowserStorage.getStorage(BrowserStorage.CORE);
		const data = await storage.get();

		data.appVersion = extVersion;
		await storage.set(data);

		storage.debugLog();
	}

	/**
	 * Stop and remove controller for a tab with a given tab ID.
	 *
	 * @param  {Number} tabId Tab ID
	 */
	async function unloadController(tabId) {
		const controller = tabControllers[tabId];
		if (!controller) {
			return;
		}

		const label = controller.getConnector().label;
		console.log(`Tab ${tabId}: Remove controller for ${label} connector`);

		controller.finish();
		delete tabControllers[tabId];
	}

	/**
	 * Enable or disable a connector attached to a given controller.
	 *
	 * @param  {Object} ctrl Controller instance
	 * @param  {Boolean} isEnabled Flag value
	 */
	function setConnectorState(ctrl, isEnabled) {
		const connector = ctrl.getConnector();

		ctrl.setEnabled(isEnabled);
		Options.setConnectorEnabled(connector, isEnabled);
	}

	/**
	 * Check if current version has notable changes
	 * and show changelog on GitHub.
	 */
	async function notifyOfNotableChanges() {
		if (versionsToNotify.includes(extVersion)) {
			const data = await notificationStorage.get();
			if (!data.changelog) {
				data.changelog = {};
			}

			if (!data.changelog[extVersion]) {
				openChangelogSection();
				data.changelog[extVersion] = true;

				await notificationStorage.set(data);
			}

			await notificationStorage.debugLog();
		}

		notificationStorage.debugLog();
	}

	/**
	 * Ask user for grant access for service covered by given scrobbler.
	 *
	 * @param  {Object} scrobbler Scrobbler instance
	 */
	async function authenticateScrobbler(scrobbler) {
		try {
			const authUrl = await scrobbler.getAuthUrl();

			ScrobbleService.bindScrobbler(scrobbler);
			browser.tabs.create({ url: authUrl });
		} catch (e) {
			console.log(`Unable to get auth URL for ${scrobbler.getLabel()}`);

			Notifications.showSignInError(scrobbler, () => {
				const statusUrl = scrobbler.getStatusUrl();
				if (statusUrl) {
					browser.tabs.create({ url: statusUrl });
				}
			});
		}
	}

	/**
	 * Check if extension should display auth notification.
	 *
	 * @return {Boolean} Check result
	 */
	async function isAuthNotificationAllowed() {
		const data = await notificationStorage.get();

		const authDisplayCount = data.authDisplayCount || 0;
		return authDisplayCount < AUTH_NOTIFICATION_DISPLAY_COUNT;
	}

	/**
	 * Update internal counter of displayed auth notifications.
	 */
	async function updateAuthDisplayCount() {
		const data = await notificationStorage.get();
		const authDisplayCount = data.authDisplayCount || 0;

		data.authDisplayCount = authDisplayCount + 1;
		await notificationStorage.set(data);
	}

	/**
	 * Called on the extension start.
	 */
	async function start() {
		await Migrate.migrate();

		currentTabId = (await Util.getCurrentTab()).id;

		await updateVersionInStorage();
		await notifyOfNotableChanges();
		setupEventListeners();

		/**
		 * Prevent restoring the browser action icon
		 * from the previous session.
		 */
		browserAction.reset();

		// track background page loaded - happens once per browser session
		GA.pageview(`/background-loaded?version=${extVersion}`);

		const boundScrobblers = await ScrobbleService.bindAllScrobblers();
		if (boundScrobblers.length > 0) {
			for (const scrobbler of boundScrobblers) {
				GA.event('core', 'bind', scrobbler.getLabel());
			}
		} else {
			console.warn('No scrobblers are bound');

			if (await isAuthNotificationAllowed()) {
				const authUrl = browser.runtime.getURL('/ui/options/index.html#accounts');
				try {
					await Notifications.showAuthNotification(() => {
						browser.tabs.create({ url: authUrl });
					});

					GA.event('core', 'auth', 'default');
				} catch (e) {
					// Fallback for browsers with no notifications support
					browser.tabs.create({ url: authUrl });

					GA.event('core', 'auth', 'fallback');
				}

				await updateAuthDisplayCount();
			}
		}
	}

	return { start };
});
