// Runs first inside the chat and settings frames. Gives the chat UI the same messaging
// object an editor webview gets, carried over postMessage to the shell, which relays it to
// the host process. The UI's own scripts are untouched.
(function () {
	const view = location.pathname.split('/').filter(Boolean).pop() || 'chat';
	const stateKey = 'stormcoder-state-' + view;
	window.acquireVsCodeApi = function () {
		return {
			postMessage: function (message) { parent.postMessage({ mj: 'toHost', view: view, message: message }, location.origin); },
			getState: function () {
				try { return JSON.parse(localStorage.getItem(stateKey) || 'null'); } catch (e) { return null; }
			},
			setState: function (state) {
				try { localStorage.setItem(stateKey, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
			},
		};
	};
	window.addEventListener('message', function (e) {
		const d = e.data;
		if (e.source !== parent || !d || typeof d.mj !== 'string') { return; }
		// Swallow the envelope so the UI's own listeners only ever see host messages.
		e.stopImmediatePropagation();
		if (d.mj === 'toView') {
			window.dispatchEvent(new MessageEvent('message', { data: d.message }));
		} else if (d.mj === 'nav') {
			window.dispatchEvent(new CustomEvent('stormcoder-nav', { detail: d }));
		}
	}, true);
	window.addEventListener('keydown', function (e) {
		// Palette and navigation shortcuts work wherever focus is.
		if ((e.ctrlKey || e.metaKey) && /^[1-4,k]$/i.test(e.key)) {
			parent.postMessage({ mj: 'key', key: e.key.toLowerCase() }, location.origin);
			e.preventDefault();
		}
	});
}());
