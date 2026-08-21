/** Verifies the initial Open-Meteo provider normalizes its public API values into the common weather model. */
const assert=require("node:assert/strict"); const test=require("node:test");
const { createOpenMeteoProvider }=require("../plugin/providers/open-meteo.cjs");
test("Open-Meteo adapter normalizes wind and direction",async()=>{
	const fetchFn=async(url)=>({ok:true,async json(){return String(url).includes("marine-api")?{hourly:{time:["2026-08-21T12:00"],wave_height:[1.2],wave_period:[6],wave_direction:[180],swell_wave_height:[.8],swell_wave_period:[8],swell_wave_direction:[225]}}:{hourly:{time:["2026-08-21T12:00"],temperature_2m:[14],wind_speed_10m:[10],wind_gusts_10m:[15],wind_direction_10m:[90]}};}});
	const value=await createOpenMeteoProvider({fetchFn}).fetch({position:{latitude:56,longitude:-5},weatherDays:7,marineDays:7,now:"2026-08-21T12:01:00Z"});
	assert.ok(Math.abs(value.current.windSpeedMps-5.14444)<1e-9); assert.ok(Math.abs(value.current.windDirectionTrueRad-Math.PI/2)<1e-9);
});
