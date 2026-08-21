/** Verifies the Weather Database table uses the same concise forecast columns and UK-local display as Planning. */
const assert=require("node:assert/strict"); const path=require("node:path"); const test=require("node:test"); const {pathToFileURL}=require("node:url");

test("forecast rows combine atmospheric and marine hourly data",async()=>{
	const view=await import(pathToFileURL(path.join(__dirname,"../public/weather-forecast-view.mjs")));
	assert.deepEqual(view.forecastColumns.map((column)=>column[1]),["Local Time (UK)","Temp (°C)","Wind (kn)","Gust (kn)","Wind Dir","Wave (m)","Period (s)","Wave Dir","Swell (m)","Swell (s)","Swell Dir"]);
	const rows=view.forecastRows({hourly:{forecast:{timezone:"GMT",hourly:{time:["2026-08-21T12:00"],temperature_2m:[14],wind_speed_10m:[12],wind_gusts_10m:[20],wind_direction_10m:[270]}},marine:{hourly:{wave_height:[1.2],wave_period:[6],wave_direction:[90],swell_wave_height:[0.8],swell_wave_period:[9],swell_wave_direction:[180]}}}});
	assert.equal(rows.length,1); assert.equal(rows[0].temperature,"14.0"); assert.equal(rows[0].windDirection,"W (270°)"); assert.equal(rows[0].waveDirection,"E (90°)"); assert.match(rows[0].localTime,/Fri 21 Aug/);
});
