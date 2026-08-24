/** Verifies simultaneous provider refresh, explicit priority, field fallback and independent offline caching. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProviderRegistry } = require("../plugin/provider-registry.cjs");
const { createWeatherDatabase, freshness, validPosition } = require("../plugin/database.cjs");

test("forecast freshness uses provider refresh periods and never expires stored data", () => {
	assert.equal(freshness("2026-08-20T00:00:00Z","2026-08-20T01:00:00Z",2).state,"fresh");
	assert.equal(freshness("2026-08-20T00:00:00Z","2026-08-20T03:00:00Z",2).state,"stale");
	assert.equal(freshness("2026-08-20T00:00:00Z","2026-08-21T01:00:00Z",2).ageBand,"warning");
	const old = freshness("2026-08-20T00:00:00Z","2026-08-23T01:00:01Z",2);
	assert.equal(old.state,"stale");
	assert.equal(old.ageBand,"danger");
	assert.equal(old.expiresAfterSeconds,null);
});
const { createOpenMeteoProvider } = require("../plugin/providers/open-meteo.cjs");
const { primaryFallbackMetadata } = require("../plugin/aggregation.cjs");

test("position validation rejects blank coercions and accepts explicit numeric coordinates", () => {
	assert.equal(validPosition({ latitude:null, longitude:null }), null);
	assert.equal(validPosition({ latitude:" ", longitude:"\t" }), null);
	assert.equal(validPosition({ latitude:false, longitude:true }), null);
	assert.equal(validPosition({ latitude:91, longitude:0 }), null);
	assert.equal(validPosition({ latitude:0, longitude:181 }), null);
	assert.deepEqual(validPosition({ latitude:"56.27", longitude:"-5.63" }), { latitude:56.27, longitude:-5.63 });
});

test("database refreshes providers simultaneously and selects fields explicitly", async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-weather-db-"));
	t.after(() => fs.rm(directory, { recursive:true, force:true }));
	const calls = [];
	let releaseProviders;
	let concurrencyTimer;
	const providersStarted = new Promise((resolve, reject) => {
		releaseProviders = resolve;
		concurrencyTimer = setTimeout(() => reject(new Error("providers did not start concurrently")), 1000);
	});
	const provider = (id,current) => ({ id,name:id,enabled:true,configured:true,persistentCachePermitted:true,capabilities:[],async fetch(){
		calls.push(id);
		if (calls.length === 2) { clearTimeout(concurrencyTimer); releaseProviders(); }
		await providersStarted;
		return { current,hourly:{ forecast:{ provider:id },marine:null } };
	} });
	const providers = createProviderRegistry([provider("first",{ temperatureC:10,windSpeedMps:null }),provider("second",{ temperatureC:12,windSpeedMps:4 })],["first","second"]);
	const database = createWeatherDatabase({ directory,providers,staleAfterHours:1,expiresAfterHours:24 });
	const result=await database.resolve({ position:{ latitude:56.2,longitude:-5.6 },now:"2026-08-21T10:00:00.000Z" });
	assert.deepEqual(calls.sort(),["first","second"]);
	assert.equal(result.selection.primaryProviderId,"first");
	assert.equal(result.current.temperatureC,10);
	assert.equal(result.current.windSpeedMps,4);
	assert.equal(result.selection.selectedProviderByField.windSpeedMps,"second");
	assert.equal(result.sources.length,2);
});

test("same-key requests share one provider refresh", async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-weather-coalesced-"));
	t.after(() => fs.rm(directory, { recursive:true, force:true }));
	let calls = 0;
	let release;
	const pending = new Promise((resolve) => { release = resolve; });
	let markStarted;
	const providerStarted = new Promise((resolve) => { markStarted = resolve; });
	const provider = { id:"coalesced", name:"Coalesced provider", enabled:true, configured:true,
		persistentCachePermitted:true, capabilities:[], async fetch() {
			calls += 1;
			markStarted();
			await pending;
			return { current:{ temperatureC:10 }, hourly:{ forecast:{ source:"network" }, marine:null } };
		} };
	const providers = createProviderRegistry([provider], ["coalesced"]);
	const database = createWeatherDatabase({ directory, providers, staleAfterHours:1, expiresAfterHours:24 });
	const request = { position:{ latitude:56.27, longitude:-5.63 } };
	const first = database.resolve(request);
	const second = database.resolve(request);
	await providerStarted;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls, 1);
	release();
	const results = await Promise.all([first, second]);
	assert.equal(results[0].valid, true);
	assert.equal(results[1].valid, true);
	assert.equal(results[0].source.cache, "network");
	assert.equal(results[1].source.cache, "network");
});

test("present-only and past-day requests use isolated cache files and contexts", async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-weather-history-cache-"));
	t.after(() => fs.rm(directory, { recursive:true, force:true }));
	const calls = [];
	const provider = { id:"history", name:"History provider", enabled:true, configured:true,
		persistentCachePermitted:true, capabilities:[], async fetch(request) {
			calls.push(request.pastDays);
			return { current:{ temperatureC:10 + request.pastDays },
				hourly:{ forecast:{ pastDays:request.pastDays }, marine:null } };
		} };
	const providers = createProviderRegistry([provider], ["history"]);
	const database = createWeatherDatabase({ directory, providers, staleAfterHours:1, expiresAfterHours:24 });
	const position = { latitude:56.27, longitude:-5.63 };

	const present = await database.resolve({ position, pastDays:0 });
	const history = await database.resolve({ position, pastDays:1 });
	const presentAgain = await database.resolve({ position, pastDays:0 });
	const historyAgain = await database.resolve({ position, pastDays:1 });

	assert.deepEqual(calls, [0, 1], "each history horizon fetches once and then reuses only its own cache");
	assert.equal(present.source.cache, "network");
	assert.equal(history.source.cache, "network");
	assert.equal(presentAgain.source.cache, "hit");
	assert.equal(historyAgain.source.cache, "hit");
	assert.equal(present.current.temperatureC, 10);
	assert.equal(history.current.temperatureC, 11);

	const providerDirectory = path.join(directory, "history");
	assert.deepEqual((await fs.readdir(providerDirectory)).sort(), [
		"56.2700_-5.6300_16_8.json",
		"56.2700_-5.6300_16_8_p1.json",
	]);
	const presentRecord = JSON.parse(await fs.readFile(path.join(providerDirectory, "56.2700_-5.6300_16_8.json"), "utf8"));
	const historyRecord = JSON.parse(await fs.readFile(path.join(providerDirectory, "56.2700_-5.6300_16_8_p1.json"), "utf8"));
	for (const record of [presentRecord, historyRecord]) {
		assert.equal(record.cacheContext.contract, "ajrm-marine-weather-cache-context-v2");
		assert.equal(record.cacheContext.contractVersion, 2);
		assert.deepEqual(record.cacheContext.position, position);
		assert.equal(record.cacheContext.weatherDays, 16);
		assert.equal(record.cacheContext.marineDays, 8);
	}
	assert.equal(presentRecord.cacheContext.pastDays, 0);
	assert.equal(historyRecord.cacheContext.pastDays, 1);
});

test("independent database instances use collision-safe atomic temporary files", async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-weather-atomic-"));
	t.after(() => fs.rm(directory, { recursive:true, force:true }));
	let arrivals = 0;
	let release;
	const bothStarted = new Promise((resolve) => { release = resolve; });
	const provider = { id:"atomic", name:"Atomic provider", enabled:true, configured:true,
		persistentCachePermitted:true, capabilities:[], async fetch() {
			arrivals += 1;
			if (arrivals === 2) release();
			await bothStarted;
			return { current:{ temperatureC:9 }, hourly:{ forecast:{ source:"network" }, marine:null } };
		} };
	const firstDatabase = createWeatherDatabase({ directory,
		providers:createProviderRegistry([provider], ["atomic"]), staleAfterHours:1, expiresAfterHours:24 });
	const secondDatabase = createWeatherDatabase({ directory,
		providers:createProviderRegistry([provider], ["atomic"]), staleAfterHours:1, expiresAfterHours:24 });
	const request = { position:{ latitude:56.27, longitude:-5.63 } };
	const results = await Promise.all([firstDatabase.resolve(request), secondDatabase.resolve(request)]);
	assert.equal(results[0].valid, true);
	assert.equal(results[1].valid, true);
	const providerDirectory = path.join(directory, "atomic");
	const files = await fs.readdir(providerDirectory);
	assert.deepEqual(files, ["56.2700_-5.6300_16_8.json"]);
	assert.equal(JSON.parse(await fs.readFile(path.join(providerDirectory, files[0]), "utf8")).valid, true);
});

test("secondary cached field fallback does not label a live primary forecast as cached", async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-weather-primary-provenance-"));
	t.after(() => fs.rm(directory, { recursive:true, force:true }));
	const position = { latitude:56.27, longitude:-5.63 };
	const primary = { id:"primary", name:"Primary live provider", enabled:true, configured:true,
		persistentCachePermitted:true, capabilities:[], async fetch() {
			return { current:{ temperatureC:10, windSpeedMps:null }, hourly:{ forecast:{ source:"live" }, marine:null } };
		} };
	const secondary = { id:"secondary", name:"Secondary cached provider", enabled:true, configured:true,
		persistentCachePermitted:true, capabilities:[], async fetch() { throw new Error("secondary offline"); } };
	const providers = createProviderRegistry([primary, secondary], ["primary", "secondary"]);
	const secondaryDirectory = path.join(directory, "secondary");
	await fs.mkdir(secondaryDirectory, { recursive:true });
	await fs.writeFile(path.join(secondaryDirectory, "56.2700_-5.6300_16_8.json"), JSON.stringify({
		providerId:"secondary", providerName:"Secondary cached provider", valid:true,
		fetchedAt:new Date(Date.now() - 2 * 3600 * 1000).toISOString(), persistent:true,
		current:{ temperatureC:12, windSpeedMps:4 }, hourly:{ forecast:{ source:"cached" }, marine:null },
		error:"", fallbackReason:null,
	}));
	const database = createWeatherDatabase({ directory, providers, staleAfterHours:1, expiresAfterHours:24 });
	const result = await database.resolve({ position });
	assert.equal(result.source.providerId, "primary");
	assert.equal(result.source.cache, "network");
	assert.equal(result.sources.find((source) => source.providerId === "secondary").cache, "fallback");
	assert.equal(result.current.windSpeedMps, 4);
	assert.deepEqual(primaryFallbackMetadata(result), { cacheFallback:false, fallbackReason:null });
});

test("exact cache order uses a recent record without fetch and refreshes before an older fallback", async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-weather-exact-order-"));
	t.after(() => fs.rm(directory, { recursive:true, force:true }));
	let providerCalls = 0;
	const provider = { id:"ordered", name:"Ordered provider", enabled:true, configured:true, persistentCachePermitted:true, capabilities:[],
		async fetch(){ providerCalls += 1; throw new Error("provider offline"); } };
	const providers = createProviderRegistry([provider], ["ordered"]);
	const database = createWeatherDatabase({ directory, providers, staleAfterHours:1, expiresAfterHours:24 });
	const providerDirectory = path.join(directory, "ordered");
	await fs.mkdir(providerDirectory, { recursive:true });
	const file = path.join(providerDirectory, "56.2700_-5.6300_16_8.json");
	const record = (fetchedAt) => ({ providerId:"ordered", providerName:"Ordered provider", valid:true, fetchedAt, persistent:true,
		current:{ temperatureC:11 }, hourly:{ forecast:{ source:"exact" }, marine:null }, error:"", fallbackReason:null });
	await fs.writeFile(file, JSON.stringify(record("2026-08-23T11:30:00.000Z")));

	const recent = await database.resolve({ position:{ latitude:56.27, longitude:-5.63 }, now:"2026-08-23T12:00:00.000Z" });
	assert.equal(recent.valid, true);
	assert.equal(recent.source.cache, "hit");
	assert.equal(providerCalls, 0, "a recent exact cache must avoid provider access");

	await fs.writeFile(file, JSON.stringify(record("2026-08-23T10:00:00.000Z")));
	const older = await database.resolve({ position:{ latitude:56.27, longitude:-5.63 }, now:"2026-08-23T12:00:00.000Z" });
	assert.equal(providerCalls, 1, "a stale exact cache must be preceded by a provider attempt");
	assert.equal(older.valid, true);
	assert.equal(older.source.cache, "fallback");
	assert.equal(older.source.fallbackReason, "provider offline");
});

test("a blackholed Open-Meteo request times out into the usable exact-location fallback", async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-weather-timeout-fallback-"));
	t.after(() => fs.rm(directory, { recursive:true, force:true }));
	const provider = createOpenMeteoProvider({ fetchFn:async () => new Promise(() => {}), timeoutMs:10 });
	const providers = createProviderRegistry([provider], ["open-meteo"]);
	const database = createWeatherDatabase({ directory, providers, staleAfterHours:1, expiresAfterHours:24 });
	const providerDirectory = path.join(directory, "open-meteo");
	await fs.mkdir(providerDirectory, { recursive:true });
	await fs.writeFile(path.join(providerDirectory, "56.2700_-5.6300_16_8.json"), JSON.stringify({
		providerId:"open-meteo", providerName:"Open-Meteo", valid:true, fetchedAt:"2026-08-23T10:00:00.000Z", persistent:true,
		current:{ temperatureC:8 }, hourly:{ forecast:{ source:"timed-cache" }, marine:null }, error:"", fallbackReason:null,
	}));

	const result = await database.resolve({ position:{ latitude:56.27, longitude:-5.63 }, now:"2026-08-23T12:00:00.000Z" });
	assert.equal(result.valid, true);
	assert.equal(result.source.cache, "fallback");
	assert.match(result.source.fallbackReason, /timed out after 10 ms/);
	assert.equal(result.current.temperatureC, 8);
});

test("nearest cached fallback selects one coordinate group and retains its location context", async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-weather-nearest-cache-"));
	t.after(() => fs.rm(directory, { recursive:true, force:true }));
	const firstPosition = { latitude:56.2, longitude:-5.6 };
	const secondPosition = { latitude:56.5, longitude:-5.3 };
	const closeTo = (left,right) => Math.abs(left.latitude - right.latitude) < 0.00001 && Math.abs(left.longitude - right.longitude) < 0.00001;
	const provider = (id, position, current) => ({ id, name:id, enabled:true, configured:true, persistentCachePermitted:true, capabilities:[],
		async fetch(request) {
			if (!closeTo(request.position, position)) throw new Error(`${id} is offline at this point`);
			return { current, hourly:{ forecast:{ provider:id }, marine:null } };
		} });
	const providers = createProviderRegistry([
		provider("first", firstPosition, { temperatureC:9, windSpeedMps:null }),
		provider("second", secondPosition, { temperatureC:12, windSpeedMps:6 }),
	], ["first", "second"]);
	const database = createWeatherDatabase({ directory, providers, staleAfterHours:1, expiresAfterHours:24 });
	await database.resolve({ position:firstPosition, contextLocation:{ id:"first-location", name:"First Point", types:["harbour"], category:"Harbour", position:firstPosition } });
	await database.resolve({ position:secondPosition, contextLocation:{ id:"second-location", name:"Second Point", types:["marina"], category:"Marina", position:secondPosition } });

	const record = JSON.parse(await fs.readFile(path.join(directory, "first", "56.2000_-5.6000_16_8.json"), "utf8"));
	assert.equal(record.cacheContext.contract, "ajrm-marine-weather-cache-context-v2");
	assert.equal(record.cacheContext.contractVersion, 2);
	assert.equal(record.cacheContext.pastDays, 0);
	assert.deepEqual(record.cacheContext.position, firstPosition);
	assert.equal(record.cacheContext.contextLocation.name, "First Point");

	const result = await database.nearestCached({ position:{ latitude:56.201, longitude:-5.601 }, fallbackReason:"network unavailable" });
	assert.equal(result.valid, true);
	assert.deepEqual(result.position, firstPosition);
	assert.equal(result.contextLocation.name, "First Point");
	assert.equal(result.current.temperatureC, 9);
	assert.equal(result.current.windSpeedMps, null, "must not fill a field from the other coordinate group");
	assert.equal(result.source.cache, "nearest-fallback");
	assert.equal(result.source.fallbackReason, "network unavailable");
	assert.equal(result.sources.find((source) => source.providerId === "second").valid, false);
});

test("nearest cached fallback matches pastDays exactly and treats legacy caches as present-only", async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-weather-nearest-history-"));
	t.after(() => fs.rm(directory, { recursive:true, force:true }));
	const provider = { id:"history", name:"History provider", enabled:true, configured:true,
		persistentCachePermitted:true, capabilities:[], async fetch(){ throw new Error("offline"); } };
	const providers = createProviderRegistry([provider], ["history"]);
	const database = createWeatherDatabase({ directory, providers, staleAfterHours:1, expiresAfterHours:24 });
	const providerDirectory = path.join(directory, "history");
	await fs.mkdir(providerDirectory, { recursive:true });
	const fetchedAt = new Date().toISOString();
	const record = (temperatureC, cacheContext) => ({ providerId:"history", providerName:"History provider", valid:true,
		fetchedAt, persistent:true, ...(cacheContext ? { cacheContext } : {}), current:{ temperatureC },
		hourly:{ forecast:{ temperatureC }, marine:null }, error:"", fallbackReason:null });
	const legacyPosition = { latitude:56.27, longitude:-5.63 };
	const historyPosition = { latitude:56.4, longitude:-5.8 };
	await fs.writeFile(path.join(providerDirectory, "56.2700_-5.6300_16_8.json"), JSON.stringify(record(7)));
	await fs.writeFile(path.join(providerDirectory, "56.4000_-5.8000_16_8_p1.json"), JSON.stringify(record(12, {
		contract:"ajrm-marine-weather-cache-context-v2", contractVersion:2, position:historyPosition,
		weatherDays:16, marineDays:8, pastDays:1, contextLocation:null,
	})));

	const requestedPosition = { latitude:56.2701, longitude:-5.6301 };
	const history = await database.nearestCached({ position:requestedPosition, pastDays:1 });
	assert.equal(history.valid, true);
	assert.deepEqual(history.position, historyPosition, "a nearer legacy p0 entry must not satisfy p1");
	assert.equal(history.current.temperatureC, 12);

	const present = await database.nearestCached({ position:requestedPosition, pastDays:0 });
	assert.equal(present.valid, true);
	assert.deepEqual(present.position, legacyPosition, "a filename-only legacy entry remains compatible with p0");
	assert.equal(present.current.temperatureC, 7);

	const unavailable = await database.nearestCached({ position:requestedPosition, pastDays:2 });
	assert.equal(unavailable.valid, false, "no other history horizon may leak into a p2 request");
});

test("nearest cached fallback reads legacy horizons and retains forecasts older than 24 hours", async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-weather-legacy-cache-"));
	t.after(() => fs.rm(directory, { recursive:true, force:true }));
	const provider = { id:"legacy", name:"Legacy provider", enabled:true, configured:true, persistentCachePermitted:true, capabilities:[], async fetch(){ throw new Error("offline"); } };
	const providers = createProviderRegistry([provider], ["legacy"]);
	const database = createWeatherDatabase({ directory, providers, staleAfterHours:1, expiresAfterHours:24 });
	await fs.mkdir(path.join(directory, "legacy"), { recursive:true });
	const currentTime = new Date();
	const record = (fetchedAt, temperatureC) => ({ providerId:"legacy", providerName:"Legacy provider", valid:true,
		fetchedAt, persistent:true, current:{ temperatureC }, hourly:{ forecast:{ source:"legacy" }, marine:null }, error:"", fallbackReason:null });
	await fs.writeFile(path.join(directory, "legacy", "56.4000_-5.7000_7_5.json"), JSON.stringify(record(currentTime.toISOString(), 8)));
	await fs.writeFile(path.join(directory, "legacy", "56.4100_-5.7100_16_8.json"), JSON.stringify(record(new Date(currentTime.getTime() - 48 * 3600 * 1000).toISOString(), 99)));

	const result = await database.nearestCached({ position:{ latitude:56.4101, longitude:-5.7101 }, now:currentTime.toISOString() });
	assert.equal(result.valid, true);
	assert.deepEqual(result.position, { latitude:56.41, longitude:-5.71 });
	assert.equal(result.current.temperatureC, 99);
	assert.equal(result.freshness.ageBand, "warning");
	assert.equal(result.contextLocation, null);
});

test("nearest cached fallback measures across the international date line", async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-weather-dateline-cache-"));
	t.after(() => fs.rm(directory, { recursive:true, force:true }));
	const provider = { id:"dateline", name:"Dateline provider", enabled:true, configured:true, persistentCachePermitted:true, capabilities:[], async fetch(){ throw new Error("offline"); } };
	const providers = createProviderRegistry([provider], ["dateline"]);
	const database = createWeatherDatabase({ directory, providers, staleAfterHours:1, expiresAfterHours:24 });
	await fs.mkdir(path.join(directory, "dateline"), { recursive:true });
	const record = (temperatureC) => ({ providerId:"dateline", providerName:"Dateline provider", valid:true,
		fetchedAt:new Date().toISOString(), persistent:true, current:{ temperatureC }, hourly:{ forecast:{}, marine:null }, error:"", fallbackReason:null });
	await fs.writeFile(path.join(directory, "dateline", "0.0000_-179.9000_16_8.json"), JSON.stringify(record(4)));
	await fs.writeFile(path.join(directory, "dateline", "0.0000_170.0000_16_8.json"), JSON.stringify(record(20)));

	const result = await database.nearestCached({ position:{ latitude:0, longitude:179.9 } });
	assert.equal(result.valid, true);
	assert.deepEqual(result.position, { latitude:0, longitude:-179.9 });
	assert.equal(result.current.temperatureC, 4);
});
