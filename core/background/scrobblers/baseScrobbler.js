'use strict';

define([
	'jquery',
	'vendor/md5',
	'objects/serviceCallResult',
	'chromeStorage',
], function ($, MD5, ServiceCallResult, ChromeStorage) {
	const GET_AUTH_URL_TIMEOUT = 10000;

	/**
	 * Base scrobbler object.
	 *
	 * This object and its ancestors MUST return ServiceCallResult instance
	 * as result or error value in methods that execute API methods.
	 */
	class BaseScrobbler {
		constructor(options) {
			this.label = options.label;
			this.apiUrl = options.apiUrl;
			this.apiKey = options.apiKey;
			this.apiSecret = options.apiSecret;
			this.authUrl = options.authUrl;
			this.statusUrl = options.statusUrl;
			this.storage = ChromeStorage.getNamespace(options.storage);
		}

		/**
		 * Creates query string from object properties.
		 *
		 * @param params
		 * @returns {string}
		 */
		createQueryString(params) {
			var parts = [];

			for (var x in params) {
				if (params.hasOwnProperty(x)) {
					parts.push(x + '=' + encodeURIComponent(params[x]));
				}
			}

			return parts.join('&');
		}

		/**
		 * Fetch auth URL where user should grant permissions to our token.
		 *
		 * Stores the new obtained token into storage so it will be traded for
		 * a new session when needed. Because of this it is necessary this method
		 * is called only when user is really going to approve the token and
		 * not sooner. Otherwise use of the token would result in an unauthorized
		 * request.
		 *
		 * See http://www.last.fm/api/show/auth.getToken
		 *
		 * @return {Promise} Promise that will be resolved with the auth URL
		 */
		getAuthUrl() {
			let url = `${this.apiUrl}?method=auth.gettoken&api_key=${this.apiKey}`;
			return timeoutPromise(GET_AUTH_URL_TIMEOUT, fetch(url, { method: 'GET' }).then((response) => {
				return response.text();
			}).then((text) => {
				let xml = $($.parseXML(text));
				let status = xml.find('lfm').attr('status');
				return new Promise((resolve, reject) => {
					this.storage.get((data) => {
						if (status !== 'ok') {
							console.log('Error acquiring a token: %s', text);

							data.token = null;
							this.storage.set(data, function() {
								reject();
							});
						} else {
							// set token and reset session so we will grab a new one
							data.sessionID = null;
							data.token = xml.find('token').text();

							let response = text.replace(data.token, `xxxxx${data.token.substr(5)}`);
							console.log(`getToken response: ${response}`);

							let authUrl = `${this.authUrl}?api_key=${this.apiKey}&token=${data.token}`;
							this.storage.set(data, function() {
								resolve(authUrl);
							});
						}
					});
				});
			}));
		}


		/**
		 * Get status page URL.
		 * @return {String} Status page URL
		 */
		getStatusUrl() {
			return this.statusUrl;
		}

		/**
		 * Calls callback with sessionID or null if there is no session or token to be traded for one.
		 * If there is a stored token it is preferably traded for a new session which is then returned.
		 * @return {Promise} Promise that will be resolved with the session data
		 */
		getSession() {
			return new Promise((resolve, reject) => {
				this.storage.get((data) => {
					// if we have a token it means it is fresh and we want to trade it for a new session ID
					var token = data.token || null;
					if (token !== null) {
						this.tradeTokenForSession(token).then((session) => {
							// token is already used, reset it and store the new session
							data.token = null;
							data.sessionID = session.key;
							data.sessionName = session.name;
							this.storage.set(data, () => {
								resolve({
									sessionID: data.sessionID,
									sessionName: data.sessionName
								});
							});
						}).catch(() => {
							console.warn(this.label + ' Failed to trade token for session - the token is probably not authorized');

							// both session and token are now invalid
							data.token = null;
							data.sessionID = null;
							data.sessionName = null;
							this.storage.set(data, () => {
								reject(ServiceCallResult.AuthError());
							});
						});
					} else if (!data.sessionID) {
						reject(ServiceCallResult.AuthError());
					} else {
						resolve({
							sessionID: data.sessionID,
							sessionName: data.sessionName
						});
					}
				});
			});
		}

		/**
		 * Does a call to API to trade token for session ID.
		 * Assumes the token was authenticated by the user.
		 *
		 * @param {String} token
		 * @return {Promise} Promise that will be resolved with the session ID
		 */
		tradeTokenForSession(token) {
			let params = {
				method: 'auth.getsession',
				api_key: this.apiKey,
				token: token
			};
			let apiSig = this.generateSign(params);
			let queryStr = this.createQueryString(params);
			let url = `${this.apiUrl}?${queryStr}&api_sig=${apiSig}&format=json`;

			return fetch(url).then((response) => {
				return response.json();
			}).then((data) => {
				console.log(JSON.stringify(data, null, 2));
				return data.session;
			}).catch((err) => {
				console.error(`${this.label} auth.tradeTokenForSession failed: ${err}`);
				throw new Error(`${this.label} auth.tradeTokenForSession failed: ${err}`);
			});
		}

		/**
		 * Computes string for signing request
		 *
		 * See http://www.last.fm/api/authspec#8
		 */
		generateSign(params) {
			var keys = [];
			var o = '';

			for (var x in params) {
				if (params.hasOwnProperty(x)) {
					keys.push(x);
				}
			}

			// params has to be ordered alphabetically
			keys.sort();

			for (var i = 0; i < keys.length; i++) {
				if (keys[i] === 'format' || keys[i] === 'callback') {
					continue;
				}

				o = o + keys[i] + params[keys[i]];
			}

			// append secret
			return MD5(o + this.apiSecret);
		}

		/**
		 * Executes asynchronous request and returns back in either callback
		 *
		 * API key will be added to params by default
		 * and all parameters will be encoded for use in query string internally
		 *
		 * @param  {String} method Used method (GET or POST)
		 * @param  {Object} params Object of key => value url parameters
		 * @param  {Boolean} signed Should the request be signed?
		 * @return {Promise} Promise that will be resolved with parsed response
		 */
		doRequest(method, params, signed) {
			params.api_key = this.apiKey;

			if (signed) {
				params.api_sig = this.generateSign(params);
			}

			let queryStr = this.createQueryString(params);
			let url = `${this.apiUrl}?${queryStr}`;

			return fetch(url, { method }).then((response) => {
				return response.text();
			}).then((text) => {
				console.log(text);
				return $($.parseXML(text));
			}).catch(() => {
				throw ServiceCallResult.OtherError();
			});
		}

		/**
		 * Asynchronously loads song info into given song object.
		 *
		 * @param  {Song} song Song instance
		 * @return {Promise} Promise that will be resolved with 'isValid' flag
		 */
		loadSongInfo() {
			return Promise.resolve(false);
		}

		isLoadSongInfoSupported() {
			return false;
		}

		/**
		 * Send current song as 'now playing' to API
		 * @param  {Object} song Song instance
		 * @return {Promise} Promise that will be resolved with ServiceCallResult object
		 */
		sendNowPlaying(song) {
			return this.getSession().then(({ sessionID }) => {
				let params = {
					method: 'track.updatenowplaying',
					track: song.getTrack(),
					artist: song.getArtist(),
					api_key: this.apiKey,
					sk: sessionID
				};

				if (song.getAlbum()) {
					params.album = song.getAlbum();
				}
				if (song.getDuration()) {
					params.duration = song.getDuration();
				}

				console.log(`${this.label} sendNowPlaying()`);

				return this.doRequest('POST', params, true).then(processResponse);
			});
		}

		/**
		 * Send song to API to scrobble
		 * @param  {Object} song Song instance
		 * @return {Promise} Promise that will be resolved with ServiceCallResult object
		 */
		scrobble(song) {
			return this.getSession().then(({ sessionID }) => {
				let params = {
					method: 'track.scrobble',
					'timestamp[0]': song.metadata.startTimestamp,
					'track[0]': song.processed.track || song.parsed.track,
					'artist[0]': song.processed.artist || song.parsed.artist,
					api_key: this.apiKey,
					sk: sessionID
				};

				if (song.getAlbum()) {
					params['album[0]'] = song.getAlbum();
				}

				console.log(this.label + ' scrobble()');

				return this.doRequest('POST', params, true).then(processResponse);
			});
		}

		/**
		 * Love or unlove given song.
		 * @param  {Object} song Song instance
		 * @param  {Boolean} isLoved Flag means song should be loved or not
		 * @return {Promise} Promise that will be resolved with ServiceCallResult object
		 */
		toggleLove(song, isLoved) {
			return this.getSession().then(({ sessionID }) => {
				let params = {
					method: 'track.' + (isLoved ? 'love' : 'unlove'),
					'track': song.processed.track || song.parsed.track,
					'artist': song.processed.artist || song.parsed.artist,
					api_key: this.apiKey,
					sk: sessionID
				};

				return this.doRequest('POST', params, true).then(processResponse);
			});
		}

		/**
		 * Get the label.
		 * @return {string} Scrobbler label
		 */
		getLabel() {
			return this.label;
		}
	}

	function processResponse($doc) {
		if ($doc.find('lfm').attr('status') !== 'ok') {
			// request passed but returned error
			return ServiceCallResult.OtherError();
		}

		return ServiceCallResult.Ok();
	}

	/**
	 * Execute promise with specified timeout.
	 * @param  {Number} timeout Timeout in milliseconds
	 * @param  {Promise} promise Promise to execute
	 * @return {Promise} Promise that will be resolved when the task has complete
	 */
	function timeoutPromise(timeout, promise) {
		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				reject(new Error('promise timeout'));
			}, timeout);
			promise.then(
				(res) => {
					clearTimeout(timeoutId);
					resolve(res);
				},
				(err) => {
					clearTimeout(timeoutId);
					reject(err);
				}
			);
		});
	}

	return BaseScrobbler;
});
