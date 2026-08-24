/** Durable provider-separated weather cache. Refreshes all enabled providers concurrently and retains offline fallbacks independently. */

const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { aggregateProviderResults } = require("./aggregation.cjs");

function validPosition(value) {
	const coordinate = (input) => {
		if (typeof input === "number") return Number.isFinite(input) ? input : null;
		if (typeof input !== "string" || !input.trim()) return null;
		const parsed = Number(input);
		return Number.isFinite(parsed) ? parsed : null;
	};
	const latitude = coordinate(value?.latitude), longitude = coordinate(value?.longitude);
	return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
		? { latitude, longitude } : null;
}
function key(position, weatherDays, marineDays, pastDays = 0) {
	const history = pastDays > 0 ? `_p${pastDays}` : "";
	return `${position.latitude.toFixed(4)}_${position.longitude.toFixed(4)}_${weatherDays}_${marineDays}${history}`.replace(/[^a-z0-9._-]+/gi, "_");
}
function requestDays(input = {}) {
	const requestedPastDays = Number(input.pastDays);
	return { weatherDays: Math.max(1, Math.min(16, Math.round(Number(input.weatherDays) || 16))),
		marineDays: Math.max(1, Math.min(8, Math.round(Number(input.marineDays) || 8))),
		pastDays: Number.isFinite(requestedPastDays) ? Math.max(0, Math.min(7, Math.round(requestedPastDays))) : 0 };
}
async function readJson(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
async function writeJson(file, value) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
		await fs.rename(temporary, file);
	} finally {
		await fs.rm(temporary, { force:true }).catch(() => {});
	}
}
function freshness(fetchedAt, now, staleHours, expireHours) {
	const fetchedTime = Date.parse(fetchedAt), currentTime = Date.parse(now);
	const ageSeconds = Number.isFinite(fetchedTime) && Number.isFinite(currentTime) ? Math.max(0, (currentTime - fetchedTime) / 1000) : null;
	if (!Number.isFinite(ageSeconds)) return { ageSeconds:null, state:"invalid",
		staleAfterSeconds:staleHours * 3600, expiresAfterSeconds:expireHours * 3600 };
	return { ageSeconds, state: ageSeconds > expireHours * 3600 ? "expired" : ageSeconds > staleHours * 3600 ? "stale" : "fresh",
		staleAfterSeconds: staleHours * 3600, expiresAfterSeconds: expireHours * 3600 };
}
function contextSummary(location) {
	if (!location) return null;
	return { id: location.id || null, name: location.name || "", types: Array.isArray(location.types) ? location.types : [],
		category: location.category || null, position: validPosition(location.position) };
}
function legacyCacheContext(filename) {
	const match = String(filename).match(/^(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)_(\d+)_(\d+)(?:_p(\d+))?\.json$/);
	if (!match) return null;
	return { position: validPosition({ latitude:match[1], longitude:match[2] }), weatherDays:Number(match[3]), marineDays:Number(match[4]), pastDays:Number(match[5] || 0), contextLocation:null };
}
function cachedContext(filename, record) {
	const stored = record?.cacheContext;
	const legacy = legacyCacheContext(filename);
	const position = validPosition(stored?.position) || legacy?.position;
	const weatherDays = Number(stored?.weatherDays ?? legacy?.weatherDays);
	const marineDays = Number(stored?.marineDays ?? legacy?.marineDays);
	const pastDays = Number(stored?.pastDays ?? legacy?.pastDays ?? 0);
	if (!position || !Number.isInteger(weatherDays) || !Number.isInteger(marineDays) || !Number.isInteger(pastDays) || pastDays < 0) return null;
	return { position, weatherDays, marineDays, pastDays, contextLocation:contextSummary(stored?.contextLocation) };
}

function createWeatherDatabase(options) {
	const { directory, providers } = options;
	const staleHours = Math.max(0.25, Number(options.staleAfterHours) || 1);
	const expireHours = Math.max(staleHours, Number(options.expiresAfterHours) || 24);
	const inFlightProviderRequests = new Map();
	async function providerResult(provider, request, force) {
		const file = path.join(directory, provider.id, `${key(request.position, request.weatherDays, request.marineDays, request.pastDays)}.json`);
		while (inFlightProviderRequests.has(file)) {
			const active = inFlightProviderRequests.get(file);
			if (active.force || !force) return active.promise;
			await active.promise.catch(() => {});
			if (inFlightProviderRequests.get(file) === active) inFlightProviderRequests.delete(file);
		}
		const entry = { force, promise:null };
		entry.promise = providerResultUncoalesced(provider, request, force, file);
		inFlightProviderRequests.set(file, entry);
		try { return await entry.promise; }
		finally { if (inFlightProviderRequests.get(file) === entry) inFlightProviderRequests.delete(file); }
	}
	async function providerResultUncoalesced(provider, request, force, file) {
		const cached = await readJson(file);
		const cachedFreshness = cached?.fetchedAt ? freshness(cached.fetchedAt, request.now, staleHours, expireHours) : null;
		if (cached?.valid !== false && !force && cachedFreshness?.state === "fresh") return { ...cached, cache: "hit", freshness: cachedFreshness };
		try {
			const value = await provider.fetch(request);
			const record = { providerId: provider.id, providerName: provider.name, valid: true,
				fetchedAt: new Date().toISOString(), persistent: provider.persistentCachePermitted,
				cacheContext:{ contract:"ajrm-marine-weather-cache-context-v2", contractVersion:2, position:request.position,
					weatherDays:request.weatherDays, marineDays:request.marineDays, pastDays:request.pastDays, contextLocation:request.contextLocation },
				current: value.current, hourly: value.hourly, error: "", fallbackReason: null };
			if (provider.persistentCachePermitted) await writeJson(file, record);
			return { ...record, cache: "network", freshness: freshness(record.fetchedAt, request.now, staleHours, expireHours) };
		} catch (error) {
			if (cached?.valid !== false && ["fresh", "stale"].includes(cachedFreshness?.state)) return { ...cached, cache: "fallback", freshness: cachedFreshness, fallbackReason: error.message };
			return { providerId: provider.id, providerName: provider.name, valid: false, persistent: provider.persistentCachePermitted,
				fetchedAt: cached?.fetchedAt || null, cache:cached ? cachedFreshness?.state === "expired" ? "expired" : "invalid" : "miss",
				freshness: cachedFreshness, error: error.message };
		}
	}
	async function resolve(input = {}) {
		const now = new Date(input.now || Date.now()).toISOString();
		const position = validPosition(input.position);
		const contextLocation = contextSummary(input.contextLocation);
		if (!position) return aggregateProviderResults([], { now, position: null, contextLocation });
		const request = { position, now, ...requestDays(input), contextLocation };
		const active = providers.enabled();
		const results = await Promise.all(active.map((provider) => providerResult(provider, request, input.force === true)));
		return aggregateProviderResults(results, { now, position, contextLocation });
	}
	async function nearestCached(input = {}) {
		const now = new Date(input.now || Date.now()).toISOString();
		const requestedPosition = validPosition(input.position);
		const days = requestDays(input);
		if (!requestedPosition) return aggregateProviderResults([], { now, position:null, contextLocation:null });
		const active = providers.enabled();
		const groups = new Map();
		for (const provider of active) {
			let files = [];
			try { files = (await fs.readdir(path.join(directory, provider.id))).filter((name) => name.endsWith(".json")); }
			catch (error) { if (error.code !== "ENOENT") throw error; }
			for (const filename of files) {
				let record = null;
				try { record = await readJson(path.join(directory, provider.id, filename)); }
				catch (error) { if (error instanceof SyntaxError) continue; throw error; }
				const context = cachedContext(filename, record);
				if (!record || !context) continue;
				const recordFreshness = record.fetchedAt ? freshness(record.fetchedAt, now, staleHours, expireHours) : null;
				if (record.valid === false || !["fresh", "stale"].includes(recordFreshness?.state)) continue;
				const groupId = key(context.position, context.weatherDays, context.marineDays, context.pastDays);
				if (!groups.has(groupId)) groups.set(groupId, { id:groupId, position:context.position, weatherDays:context.weatherDays,
					marineDays:context.marineDays, pastDays:context.pastDays, contextLocation:context.contextLocation, records:new Map() });
				const group = groups.get(groupId);
				if (!group.contextLocation && context.contextLocation) group.contextLocation = context.contextLocation;
				group.records.set(provider.id, { record, freshness:recordFreshness });
			}
		}
		const requestedHorizon = (group) => group.weatherDays === days.weatherDays && group.marineDays === days.marineDays ? 0 : 1;
		const compatibleGroups = [...groups.values()].filter((group) => group.pastDays === days.pastDays);
		const selected = compatibleGroups.sort((left,right) => distanceSquared(requestedPosition, left.position) - distanceSquared(requestedPosition, right.position)
			|| requestedHorizon(left) - requestedHorizon(right) || (right.weatherDays + right.marineDays) - (left.weatherDays + left.marineDays)
			|| left.id.localeCompare(right.id))[0];
		if (!selected) return aggregateProviderResults([], { now, position:null, contextLocation:null });
		const reason = String(input.fallbackReason || "The nearest weather location is unavailable; using the nearest non-expired cached forecast.");
		const results = active.map((provider) => {
			const available = selected.records.get(provider.id);
			if (!available) return { providerId:provider.id, providerName:provider.name, valid:false,
				persistent:provider.persistentCachePermitted, fetchedAt:null, cache:"miss", freshness:null,
				error:"No cached provider forecast exists at the selected cached location." };
			return { ...available.record, providerId:provider.id, providerName:provider.name, valid:true,
				cache:"nearest-fallback", freshness:available.freshness, fallbackReason:reason, error:"" };
		});
		return aggregateProviderResults(results, { now, position:selected.position, contextLocation:selected.contextLocation });
	}
	async function status() {
		const entries = [];
		for (const provider of providers.list()) {
			let files = [];
			try { files = (await fs.readdir(path.join(directory, provider.id))).filter((name) => name.endsWith(".json")); } catch (error) { if (error.code !== "ENOENT") throw error; }
			entries.push({ ...provider, cacheEntries: files.length });
		}
		return { providers: entries, cacheEntries: entries.reduce((sum, entry) => sum + entry.cacheEntries, 0) };
	}
	return { resolve, nearestCached, status };
}

function distanceSquared(left, right) {
	const latitude1 = left.latitude * Math.PI / 180, latitude2 = right.latitude * Math.PI / 180;
	const deltaLatitude = latitude2 - latitude1;
	const deltaLongitude = (right.longitude - left.longitude) * Math.PI / 180;
	return Math.sin(deltaLatitude / 2) ** 2 + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;
}

module.exports = { createWeatherDatabase, validPosition };
