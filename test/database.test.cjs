/** Verifies simultaneous provider refresh, explicit priority, field fallback and independent offline caching. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProviderRegistry } = require("../plugin/provider-registry.cjs");
const { createWeatherDatabase } = require("../plugin/database.cjs");

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
