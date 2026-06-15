import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'node:path';
import fetch from 'node-fetch';
import { getEnv } from '../lib/util/env';

async function fetchText(url: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
	}
	return response.text();
}

async function fetchBinary(url: string): Promise<Buffer> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
	}
	return Buffer.from(await response.arrayBuffer());
}

async function setup() {
	try {
		const configUrl = getEnv('CONFIG_URL');
		const faviconUrl = getEnv('FAVICON_URL');

		const [configText, faviconBuffer] = await Promise.all([
			fetchText(configUrl),
			fetchBinary(faviconUrl)
		]);

		writeFileSync('src/lib/config/config.ts', configText, 'utf8');
		console.log('Config file successfully updated');

		const faviconPath = path.join('static', 'favicon.png');
		mkdirSync(path.dirname(faviconPath), { recursive: true });
		writeFileSync(faviconPath, faviconBuffer);
		console.log('Favicon successfully updated');
	} catch (error) {
		console.error('Error during setup:', error);
		process.exit(1);
	}
}

setup();
