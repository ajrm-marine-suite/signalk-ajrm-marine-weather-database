/** Verifies Weather Database location search across names, kinds and descriptions. */

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

test("weather location search matches every term across useful location fields", async () => {
	const { filterWeatherLocations } = await import(pathToFileURL(path.join(__dirname, "../public/weather-location-search.mjs")));
	const locations = [
		{ id:"a", name:"Cuan Sound", category:"Tidal gate", description:"Strong streams", types:["tidalGate"] },
		{ id:"b", name:"Port Ellen", category:"Marina", description:"Sheltered pontoons", types:["marina"] },
		{ id:"c", name:"Bagh nam Muc", category:"Anchorage", description:"Good holding", types:["anchorage"] },
	];
	assert.deepEqual(filterWeatherLocations(locations, "port").map(({ id }) => id), ["b"]);
	assert.deepEqual(filterWeatherLocations(locations, "tidal strong").map(({ id }) => id), ["a"]);
	assert.deepEqual(filterWeatherLocations(locations, "GOOD anchorage").map(({ id }) => id), ["c"]);
	assert.equal(filterWeatherLocations(locations, "missing").length, 0);
	assert.deepEqual(filterWeatherLocations(locations, "").map(({ id }) => id), ["a", "b", "c"]);
});
