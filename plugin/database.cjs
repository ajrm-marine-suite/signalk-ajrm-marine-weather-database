/** Durable provider-separated weather cache. Refreshes all enabled providers concurrently and retains offline fallbacks independently. */

const fs = require("node:fs/promises");
const path = require("node:path");
const { aggregateProviderResults } = require("./aggregation.cjs");

function validPosition(value) {
	const latitude = Number(value?.latitude), longitude = Number(value?.longitude);
	return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
		? { latitude, longitude } : null;
}
function key(position, weatherDays, marineDays) {
	return `${position.latitude.toFixed(4)}_${position.longitude.toFixed(4)}_${weatherDays}_${marineDays}`.replace(/[^a-z0-9._-]+/gi, "_");
}
async function readJson(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
async function writeJson(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await fs.rename(temporary, file); }
function freshness(fetchedAt, now, staleHours, expireHours) {
	const ageSeconds = Math.max(0, (Date.parse(now) - Date.parse(fetchedAt)) / 1000);
	return { ageSeconds, state: ageSeconds > expireHours * 3600 ? "expired" : ageSeconds > staleHours * 3600 ? "stale" : "fresh",
		staleAfterSeconds: staleHours * 3600, expiresAfterSeconds: expireHours * 3600 };
}
function contextSummary(location) { return location ? { id: location.id, name: location.name, types: location.types } : null; }

function createWeatherDatabase(options) {
	const { directory, providers } = options;
	const staleHours = Math.max(0.25, Number(options.staleAfterHours) || 1);
	const expireHours = Math.max(staleHours, Number(options.expiresAfterHours) || 24);
	async function providerResult(provider, request, force) {
		const file = path.join(directory, provider.id, `${key(request.position, request.weatherDays, request.marineDays)}.json`);
		const cached = await readJson(file);
		const cachedFreshness = cached?.fetchedAt ? freshness(cached.fetchedAt, request.now, staleHours, expireHours) : null;
		if (cached && !force && cachedFreshness?.state === "fresh") return { ...cached, cache: "hit", freshness: cachedFreshness };
		try {
			const value = await provider.fetch(request);
			const record = { providerId: provider.id, providerName: provider.name, valid: true,
				fetchedAt: new Date().toISOString(), persistent: provider.persistentCachePermitted,
				current: value.current, hourly: value.hourly, error: "", fallbackReason: null };
			if (provider.persistentCachePermitted) await writeJson(file, record);
			return { ...record, cache: "network", freshness: freshness(record.fetchedAt, request.now, staleHours, expireHours) };
		} catch (error) {
			if (cached && cachedFreshness?.state !== "expired") return { ...cached, cache: "fallback", freshness: cachedFreshness, fallbackReason: error.message };
			return { providerId: provider.id, providerName: provider.name, valid: false, persistent: provider.persistentCachePermitted,
				fetchedAt: cached?.fetchedAt || null, cache: cached ? "expired" : "miss", freshness: cachedFreshness, error: error.message };
		}
	}
	async function resolve(input = {}) {
		const now = new Date(input.now || Date.now()).toISOString();
		const position = validPosition(input.position);
		const contextLocation = contextSummary(input.contextLocation);
		if (!position) return aggregateProviderResults([], { now, position: null, contextLocation });
		const request = { position, now, weatherDays: Math.max(1, Math.min(16, Math.round(Number(input.weatherDays) || 16))),
			marineDays: Math.max(1, Math.min(8, Math.round(Number(input.marineDays) || 8))) };
		const active = providers.enabled();
		const results = await Promise.all(active.map((provider) => providerResult(provider, request, input.force === true)));
		return aggregateProviderResults(results, { now, position, contextLocation });
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
	async function importLegacyOpenMeteo(legacyDirectory) {
		let names = [];
		try { names = (await fs.readdir(legacyDirectory)).filter((name) => /^weather-.*\.json$/.test(name)); }
		catch (error) { if (error.code === "ENOENT") return 0; throw error; }
		let imported = 0;
		for (const name of names) {
			const destination = path.join(directory, "open-meteo", name.replace(/^weather-/, ""));
			if (await readJson(destination)) continue;
			const legacy = await readJson(path.join(legacyDirectory, name));
			if (!legacy?.source?.fetchedAt || !legacy?.hourly) continue;
			await writeJson(destination, { providerId:"open-meteo", providerName:"Open-Meteo", valid:legacy.valid === true,
				fetchedAt:legacy.source.fetchedAt, persistent:true, current:legacy.current || null, hourly:legacy.hourly,
				error:legacy.error || "", fallbackReason:legacy.source.fallbackReason || null });
			imported += 1;
		}
		return imported;
	}
	return { resolve, status, importLegacyOpenMeteo };
}

module.exports = { createWeatherDatabase, validPosition };
