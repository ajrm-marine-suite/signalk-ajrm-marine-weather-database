/** Verifies the initial Open-Meteo provider normalizes its public API values into the common weather model. */
const assert=require("node:assert/strict"); const test=require("node:test");
const { createOpenMeteoProvider,currentSummary }=require("../plugin/providers/open-meteo.cjs");
test("Open-Meteo adapter normalizes wind and direction",async()=>{
	const urls=[];
	const fetchFn=async(url)=>{urls.push(new URL(url));return{ok:true,async json(){return String(url).includes("marine-api")?{hourly:{time:["2026-08-21T12:00"],wave_height:[1.2],wave_period:[6],wave_direction:[180],swell_wave_height:[.8],swell_wave_period:[8],swell_wave_direction:[225]}}:{hourly:{time:["2026-08-21T12:00"],temperature_2m:[14],wind_speed_10m:[10],wind_gusts_10m:[15],wind_direction_10m:[90]}};}};};
	const value=await createOpenMeteoProvider({fetchFn}).fetch({position:{latitude:56,longitude:-5},weatherDays:7,marineDays:7,pastDays:1,now:"2026-08-21T12:01:00Z"});
	assert.ok(Math.abs(value.current.windSpeedMps-5.14444)<1e-9); assert.ok(Math.abs(value.current.windDirectionTrueRad-Math.PI/2)<1e-9);
	assert.equal(urls.length,2);
	for(const url of urls){assert.equal(url.searchParams.get("timezone"),"GMT");assert.equal(url.searchParams.get("past_days"),"1");assert.equal(url.searchParams.has("past_hours"),false);}
});

test("Open-Meteo owns its configured forecast refresh period",()=>{
	assert.equal(createOpenMeteoProvider({fetchFn:async()=>{},refreshAfterHours:3}).refreshAfterHours,3);
	assert.equal(createOpenMeteoProvider({fetchFn:async()=>{}}).refreshAfterHours,1);
});

test("current summary remains nearest to now when hourly series includes the prior day",()=>{
	const forecast={hourly:{
		time:["2026-08-20T23:00","2026-08-21T06:00","2026-08-21T07:00"],
		temperature_2m:[3,11,13],wind_speed_10m:[2,6,8],wind_gusts_10m:[4,9,12],wind_direction_10m:[30,90,120],
	}};
	const marine={hourly:{
		time:["2026-08-20T23:00","2026-08-21T06:00","2026-08-21T07:00"],
		wave_height:[0.2,0.8,1.1],wave_period:[3,5,7],wave_direction:[10,180,210],
		swell_wave_height:[0.1,0.5,0.7],swell_wave_period:[4,8,10],swell_wave_direction:[20,220,240],
	}};
	const value=currentSummary(forecast,marine,"2026-08-21T06:40:00Z");
	assert.equal(value.at,"2026-08-21T07:00Z");
	assert.equal(value.temperatureC,13);
	assert.ok(Math.abs(value.windSpeedMps-8*.514444)<1e-9);
	assert.equal(value.waveHeightM,1.1);
	assert.equal(value.wavePeriodSeconds,7);
});

test("Open-Meteo adapter bounds a blackholed fetch and aborts both requests",async()=>{
	const signals=[];
	const fetchFn=async(_url,options)=>{signals.push(options.signal);return new Promise(()=>{});};
	const provider=createOpenMeteoProvider({fetchFn,timeoutMs:10});
	await assert.rejects(provider.fetch({position:{latitude:56,longitude:-5},weatherDays:7,marineDays:7,now:"2026-08-23T12:00:00Z"}),
		/timed out after 10 ms/);
	assert.equal(signals.length,2);
	assert.ok(signals.every((signal)=>signal instanceof AbortSignal && signal.aborted));
});
