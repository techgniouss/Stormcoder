import fs from 'node:fs';
import http from 'node:http';
const port = Number(process.env.PORT || 4791);
http.createServer((req, res) => {
	if (req.url === '/ping') {
		fs.appendFileSync(new URL('.hits', import.meta.url), 'ping\n');
		res.end('pong-4791');
	} else {
		res.statusCode = 404;
		res.end('no');
	}
}).listen(port, '127.0.0.1', () => console.log('listening on ' + port));
