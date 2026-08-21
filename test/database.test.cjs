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
	const provider = (id,current,delay) => ({ id,name:id,enabled:true,configured:true,persistentCachePermitted:true,capabilities:[],async fetch(){ calls.push(id); await new Promise((resolve)=>setTimeout(resolve,delay)); return { current,hourly:{ forecast:{ provider:id },marine:null } }; } });
	const providers = createProviderRegistry([provider("first",{ temperatureC:10,windSpeedMps:null },30),provider("second",{ temperatureC:12,windSpeedMps:4 },30)],["first","second"]);
	const database = createWeatherDatabase({ directory,providers,staleAfterHours:1,expiresAfterHours:24 });
	const started=Date.now();
	const result=await database.resolve({ position:{ latitude:56.2,longitude:-5.6 },now:"2026-08-21T10:00:00.000Z" });
	assert.ok(Date.now()-started < 58, "providers should run concurrently");
	assert.deepEqual(calls.sort(),["first","second"]);
	assert.equal(result.selection.primaryProviderId,"first");
	assert.equal(result.current.temperatureC,10);
	assert.equal(result.current.windSpeedMps,4);
	assert.equal(result.selection.selectedProviderByField.windSpeedMps,"second");
	assert.equal(result.sources.length,2);
});

test("database imports the former Location Editor Open-Meteo cache once", async (t) => {
	const root=await fs.mkdtemp(path.join(os.tmpdir(),"ajrm-weather-migrate-")); t.after(()=>fs.rm(root,{recursive:true,force:true}));
	const legacy=path.join(root,"legacy"),directory=path.join(root,"new"); await fs.mkdir(legacy,{recursive:true});
	await fs.writeFile(path.join(legacy,"weather-56.0000_-5.0000_16_8.json"),JSON.stringify({valid:true,current:{temperatureC:12},hourly:{forecast:{hourly:{}},marine:{hourly:{}}},source:{fetchedAt:"2026-08-21T10:00:00Z"}}));
	const providers=createProviderRegistry([{id:"open-meteo",name:"Open-Meteo",enabled:true,configured:false,persistentCachePermitted:true,capabilities:[]}]);
	const database=createWeatherDatabase({directory,providers});
	assert.equal(await database.importLegacyOpenMeteo(legacy),1); assert.equal(await database.importLegacyOpenMeteo(legacy),0);
	assert.equal((await database.status()).providers[0].cacheEntries,1);
});
