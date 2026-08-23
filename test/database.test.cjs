/** Verifies simultaneous provider refresh, explicit priority, field fallback and independent offline caching. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProviderRegistry } = require("../plugin/provider-registry.cjs");
const { createWeatherDatabase, validPosition } = require("../plugin/database.cjs");
const { createOpenMeteoProvider } = require("../plugin/providers/open-meteo.cjs");

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
	assert.equal(record.cacheContext.contract, "ajrm-marine-weather-cache-context-v1");
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

test("nearest cached fallback reads legacy horizons and rejects expired entries", async (t) => {
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
	assert.deepEqual(result.position, { latitude:56.4, longitude:-5.7 });
	assert.equal(result.current.temperatureC, 8);
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
