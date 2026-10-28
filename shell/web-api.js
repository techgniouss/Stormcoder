// Development fallback: when the shell is opened in an ordinary browser (npm run dev:web)
// instead of Electron, there is no preload bridge, so the same API is carried over a local
// WebSocket to the host. In the app this file does nothing.
(function () {
	if (window.stormcoder) { return; }
	const params = new URLSearchParams(location.search);
	const socket = new WebSocket('ws://127.0.0.1:' + (params.get('port') || '0') + '/');
	const listeners = {};
	const calls = new Map();
	let seq = 0;
	const queue = [];
	const send = msg => { if (socket.readyState === 1) { socket.send(JSON.stringify(msg)); } else { queue.push(msg); } };
	socket.addEventListener('open', () => { while (queue.length) { socket.send(JSON.stringify(queue.shift())); } });
	socket.addEventListener('message', e => {
		const m = JSON.parse(e.data);
		if (m.reply !== undefined) { const c = calls.get(m.reply); if (c) { calls.delete(m.reply); m.error ? c.reject(new Error(m.error)) : c.resolve(m.value); } return; }
		(listeners[m.channel] || []).forEach(l => l(m.payload));
	});
	const on = channel => cb => { (listeners[channel] = listeners[channel] || []).push(cb); return () => { listeners[channel] = listeners[channel].filter(x => x !== cb); }; };
	const invoke = (name, ...args) => new Promise((resolve, reject) => { const id = ++seq; calls.set(id, { resolve, reject }); send({ call: name, id, args }); });
	window.stormcoder = {
		ready: () => send({ call: 'ready', args: [] }),
		sendToView: (view, message) => send({ call: 'sendToView', args: [view, message] }),
		respond: (id, value) => send({ call: 'respond', args: [id, value] }),
		command: (id, ...args) => invoke('command', id, ...args),
		readFile: f => invoke('readFile', f),
		writeFile: (f, t) => invoke('writeFile', f, t),
		openDialog: o => invoke('openDialog', o),
		onViewMessage: on('view:message'), onViewReload: on('view:reload'), onRequest: on('ui:request'),
		onEvent: on('ui:event'), onState: on('app:state'), onNavigate: on('app:navigate'), onPalette: on('app:palette'), onUpdate: on('app:update'),
	};
}());
