/** Verifies Signal K lifecycle, service registration, status publication and public icon packaging. */
const assert=require("node:assert/strict"); const fs=require("node:fs"); const fsp=require("node:fs/promises"); const os=require("node:os"); const path=require("node:path"); const test=require("node:test");
const createPlugin=require("../plugin/index.cjs");
test("plugin registers standalone weather service and retracts it on stop",async(t)=>{
	const directory=await fsp.mkdtemp(path.join(os.tmpdir(),"ajrm-weather-plugin-")); t.after(()=>fsp.rm(directory,{recursive:true,force:true}));
	const forecastLocation={id:"weather-1",name:"Cuan Sound weather forecast",description:"Forecast point",types:["weatherForecastLocation"],revision:3,feature:{geometry:{type:"Point",coordinates:[-5.63,56.27]}}};
	const anchorage={id:"anchorage-1",name:"Cuan anchorage",description:"Sheltered anchorage",types:["anchorage"],revision:2,feature:{geometry:{type:"Polygon",coordinates:[[[-5.64,56.26],[-5.62,56.26],[-5.63,56.28],[-5.64,56.26]]]}}};
	const standardPort={id:"port-1",name:"Oban",description:"Standard port",types:["tidalStandardPort"],revision:4,feature:{geometry:{type:"Point",coordinates:[-5.47,56.41]}}};
	const tidalGate={id:"gate-1",name:"Cuan Sound gate",description:"Tidal gate",types:["tidalGate"],revision:5,feature:{geometry:{type:"Point",coordinates:[-5.61,56.25]}}};
	const hazard={id:"hazard-1",name:"Rock",types:["hazard"],feature:{geometry:{type:"Point",coordinates:[-5.5,56.3]}}};
	const allLocations=[forecastLocation,anchorage,standardPort,tidalGate,hazard];
	const messages=[]; const app={getDataDirPath:()=>directory,setPluginStatus(){},handleMessage(_id,message){messages.push(message);},subscriptionmanager:{subscribe(){}},ajrmMarineLocations:{contract:"ajrm-marine-locations-service-v1",async list(){return allLocations;},async get(id){return allLocations.find((location)=>location.id===id)||null;}}};
	const plugin=createPlugin(app); plugin.start({openMeteoEnabled:false});
	assert.equal(app.ajrmMarineWeatherDatabase.contract,"ajrm-marine-weather-database-service-v1");
	assert.equal(typeof app.ajrmMarineWeatherDatabase.forecastAt,"function");
	assert.equal(globalThis[Symbol.for("mcdonaldajr.ajrmMarineWeatherDatabase")],app.ajrmMarineWeatherDatabase);
	const status=await app.ajrmMarineWeatherDatabase.databaseStatus(); assert.equal(status.contract,"ajrm-marine-weather-database-status-v1"); assert.equal(status.providers[0].enabled,false);
	assert.equal(status.weatherLocationCount,4); assert.equal(status.locationsService,"ajrm-marine-locations-service-v1");
	assert.deepEqual(await app.ajrmMarineWeatherDatabase.listLocations(),[
		{id:"anchorage-1",name:"Cuan anchorage",description:"Sheltered anchorage",types:["anchorage"],category:"Anchorage",position:{longitude:-5.6325,latitude:56.265},revision:2},
		{id:"weather-1",name:"Cuan Sound weather forecast",description:"Forecast point",types:["weatherForecastLocation"],category:"Forecast point",position:{longitude:-5.63,latitude:56.27},revision:3},
		{id:"port-1",name:"Oban",description:"Standard port",types:["tidalStandardPort"],category:"Standard tidal port",position:{longitude:-5.47,latitude:56.41},revision:4},
		{id:"gate-1",name:"Cuan Sound gate",description:"Tidal gate",types:["tidalGate"],category:"Tidal gate",position:{longitude:-5.61,latitude:56.25},revision:5},
	]);
	const publishedStatus=messages.flatMap((message)=>message.updates || []).flatMap((update)=>update.values || []).find((value)=>value.path==="plugins.ajrmMarineWeatherDatabase")?.value;
	assert.equal(publishedStatus.contract,"ajrm-marine-weather-database-status-v1");
	assert.equal(publishedStatus.contractVersion,1);
	assert.equal(publishedStatus.plugin,"signalk-ajrm-marine-weather-database");
	assert.equal(publishedStatus.enabled,true);
	plugin.stop(); assert.equal(app.ajrmMarineWeatherDatabase,undefined); assert.equal(globalThis[Symbol.for("mcdonaldajr.ajrmMarineWeatherDatabase")],undefined);
	assert.ok(messages.some((message)=>message.updates?.some((update)=>update.values?.some((value)=>value.path==="plugins.ajrmMarineWeatherDatabase"))));
});
test("appIcon exists at package root and served public path",()=>{const packageJson=require("../package.json"); assert.equal(packageJson.signalk.appIcon,"./icon-120.png"); for(const file of ["../icon-120.png","../public/icon-120.png"]) assert.ok(fs.statSync(path.join(__dirname,file)).size>100);});

test("forced weather refresh requires Signal K write access",async(t)=>{
	const directory=await fsp.mkdtemp(path.join(os.tmpdir(),"ajrm-weather-auth-plugin-")); t.after(()=>fsp.rm(directory,{recursive:true,force:true}));
	const app={getDataDirPath:()=>directory,setPluginStatus(){},handleMessage(){},subscriptionmanager:{subscribe(){}},ajrmMarineLocations:{async list(){return[];}}};
	const plugin=createPlugin(app); plugin.start({openMeteoEnabled:false}); t.after(()=>plugin.stop());
	const routes=new Map(); const registrations=[];
	const router={access(level){return{
		get(route,handler){registrations.push({method:"GET",route,level});routes.set(`GET ${route}`,handler);},
		post(route,handler){registrations.push({method:"POST",route,level});routes.set(`POST ${route}`,handler);},
	};}};
	plugin.registerWithRouter(router);
	assert.deepEqual(registrations,[
		{method:"GET",route:"/status",level:"readonly"},
		{method:"GET",route:"/providers",level:"readonly"},
		{method:"GET",route:"/locations",level:"readonly"},
		{method:"GET",route:"/weather/status",level:"readonly"},
		{method:"GET",route:"/weather/nearest",level:"readonly"},
		{method:"POST",route:"/weather/refresh",level:"readwrite"},
	]);
	const call=async(req)=>{const response={statusCode:200,status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;}}; await routes.get("POST /weather/refresh")({method:"POST",body:{},...req},response); return response;};
	assert.equal((await call({skIsAuthenticated:false})).statusCode,403);
	assert.equal((await call({skIsAuthenticated:true,skPrincipal:{permissions:"readonly"}})).statusCode,403);
	assert.equal((await call({skIsAuthenticated:true,skPrincipal:{permissions:"readwrite"}})).statusCode,200);
	assert.equal((await call({})).statusCode,200,"security-disabled Signal K keeps legacy local access");
	const refreshOperation=plugin.getOpenApi().paths["/weather/refresh"].post;
	assert.deepEqual(refreshOperation.security,[{signalk:[]}]);
	assert.equal(refreshOperation["x-signalk-access"],"readwrite");
	assert.equal(refreshOperation.responses["400"].content["application/json"].schema.$ref,"#/components/schemas/ErrorResponse");
	assert.equal(plugin.getOpenApi().components.schemas.ErrorResponse.required.includes("error"),true);
	assert.equal(refreshOperation.responses["403"].description.includes("read/write"),true);
	assert.deepEqual(refreshOperation.requestBody.content["application/json"].schema.properties.pastDays,{type:"integer",minimum:0,maximum:7,default:0,description:"Include this many completed GMT calendar days before the forecast period. Cache entries are isolated by this value."});
	for(const pathName of ["/weather/status","/weather/nearest"]){
		const parameter=plugin.getOpenApi().paths[pathName].get.parameters.find((entry)=>entry.name==="pastDays");
		assert.deepEqual(parameter.schema,{type:"integer",minimum:0,maximum:7,default:0});
	}
});

test("weather routes pass pastDays from GET queries and POST bodies to both Open-Meteo requests",async(t)=>{
	const directory=await fsp.mkdtemp(path.join(os.tmpdir(),"ajrm-weather-history-routes-")); t.after(()=>fsp.rm(directory,{recursive:true,force:true}));
	const originalFetch=globalThis.fetch; const urls=[];
	globalThis.fetch=async(url)=>{urls.push(new URL(url));return{ok:true,async json(){
		return String(url).includes("marine-api")
			? {hourly:{time:["2026-08-24T07:00"],wave_height:[1],wave_period:[6],wave_direction:[180],swell_wave_height:[.5],swell_wave_period:[8],swell_wave_direction:[220]}}
			: {hourly:{time:["2026-08-24T07:00"],temperature_2m:[12],wind_speed_10m:[8],wind_gusts_10m:[11],wind_direction_10m:[90]}};
	}};};
	t.after(()=>{globalThis.fetch=originalFetch;});
	const app={getDataDirPath:()=>directory,setPluginStatus(){},handleMessage(){},subscriptionmanager:{subscribe(){}},ajrmMarineLocations:{async list(){return[];}}};
	const plugin=createPlugin(app); plugin.start({openMeteoEnabled:true}); t.after(()=>plugin.stop());
	const routes=new Map(); plugin.registerWithRouter({
		get(route,handler){routes.set(`GET ${route}`,handler);},
		post(route,handler){routes.set(`POST ${route}`,handler);},
	});
	const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;}});
	const getResponse=response();
	await routes.get("GET /weather/status")({method:"GET",query:{latitude:"56.27",longitude:"-5.63",pastDays:"1"}},getResponse);
	assert.equal(getResponse.statusCode,200); assert.equal(getResponse.body.valid,true);
	const postResponse=response();
	await routes.get("POST /weather/refresh")({method:"POST",body:{latitude:56.27,longitude:-5.63,pastDays:2}},postResponse);
	assert.equal(postResponse.statusCode,200); assert.equal(postResponse.body.valid,true);
	assert.equal(urls.length,4);
	assert.deepEqual(urls.slice(0,2).map((url)=>url.searchParams.get("past_days")),["1","1"]);
	assert.deepEqual(urls.slice(2).map((url)=>url.searchParams.get("past_days")),["2","2"]);
});

test("router registration falls back when Signal K access routers are unavailable",async(t)=>{
	const directory=await fsp.mkdtemp(path.join(os.tmpdir(),"ajrm-weather-router-fallback-")); t.after(()=>fsp.rm(directory,{recursive:true,force:true}));
	const app={getDataDirPath:()=>directory,setPluginStatus(){},handleMessage(){},subscriptionmanager:{subscribe(){}},ajrmMarineLocations:{async list(){return[];}}};
	const plugin=createPlugin(app); plugin.start({openMeteoEnabled:false}); t.after(()=>plugin.stop());
	const routes=[]; plugin.registerWithRouter({
		get(route){routes.push(`GET ${route}`);},
		post(route){routes.push(`POST ${route}`);},
	});
	assert.deepEqual(routes,["GET /status","GET /providers","GET /locations","GET /weather/status","GET /weather/nearest","POST /weather/refresh"]);
});

test("weather locations reject invalid geometry and do not let blank direct positions override valid features",async(t)=>{
	const directory=await fsp.mkdtemp(path.join(os.tmpdir(),"ajrm-weather-position-plugin-")); t.after(()=>fsp.rm(directory,{recursive:true,force:true}));
	const validFeature={id:"valid-feature",name:"Valid feature",types:["harbour"],position:{latitude:null,longitude:" "},feature:{geometry:{type:"Point",coordinates:[-5.63,56.27]}}};
	const invalidFeature={id:"invalid-feature",name:"Invalid feature",types:["marina"],feature:{geometry:{type:"Point",coordinates:[200,95]}}};
	const app={getDataDirPath:()=>directory,setPluginStatus(){},handleMessage(){},subscriptionmanager:{subscribe(){}},ajrmMarineLocations:{async list(){return[validFeature,invalidFeature];}}};
	const plugin=createPlugin(app); plugin.start({openMeteoEnabled:false}); t.after(()=>plugin.stop());
	const locations=await app.ajrmMarineWeatherDatabase.listLocations();
	assert.equal(locations.length,1);
	assert.equal(locations[0].id,"valid-feature");
	assert.deepEqual(locations[0].position,{latitude:56.27,longitude:-5.63});
});

test("nearest weather contract resolves a Locations point then falls back to one nearest cached point",async(t)=>{
	const directory=await fsp.mkdtemp(path.join(os.tmpdir(),"ajrm-weather-nearest-plugin-")); t.after(()=>fsp.rm(directory,{recursive:true,force:true}));
	const originalFetch=globalThis.fetch; let fetchMode="fail", fetchCalls=0, providerStartedResolve=()=>{}, pendingRejects=[];
	globalThis.fetch=async()=>{fetchCalls+=1;if(fetchMode==="pending")return new Promise((_resolve,reject)=>{pendingRejects.push(reject);if(pendingRejects.length===2)providerStartedResolve();});throw new Error("Pi offline");};
	t.after(()=>{globalThis.fetch=originalFetch;});
	const nearest={id:"nearest",name:"Nearest harbour",description:"Nearest named point",types:["harbour"],revision:1,feature:{geometry:{type:"Point",coordinates:[-5.63,56.27]}}};
	const cached={id:"cached",name:"Cached marina",description:"Cached named point",types:["marina"],revision:1,feature:{geometry:{type:"Point",coordinates:[-5.3,56.5]}}};
	const app={getDataDirPath:()=>directory,setPluginStatus(){},handleMessage(){},subscriptionmanager:{subscribe(){}},
		ajrmMarineLocations:{contract:"ajrm-marine-locations-service-v1",async list(){return[nearest,cached];},async get(id){return[nearest,cached].find((location)=>location.id===id)||null;}}};
	const plugin=createPlugin(app); plugin.start({openMeteoEnabled:true}); t.after(()=>plugin.stop());
	assert.equal(app.ajrmMarineWeatherDatabase.contract,"ajrm-marine-weather-database-service-v1");
	assert.equal(app.ajrmMarineWeatherDatabase.contractVersion,1);
	assert.equal(typeof app.ajrmMarineWeatherDatabase.resolveNearest,"function");
	const providerDirectory=path.join(directory,"providers","open-meteo"); await fsp.mkdir(providerDirectory,{recursive:true});
	const weatherRecord=(position,contextLocation)=>({providerId:"open-meteo",providerName:"Open-Meteo",valid:true,fetchedAt:new Date().toISOString(),persistent:true,
		cacheContext:{contract:"ajrm-marine-weather-cache-context-v1",position,weatherDays:16,marineDays:8,contextLocation},
		current:{temperatureC:10,windSpeedMps:4},hourly:{forecast:{hourly:{time:["2026-08-23T10:00"]}},marine:null},error:"",fallbackReason:null});
	const nearestPosition={latitude:56.27,longitude:-5.63};
	const nearestFile=path.join(providerDirectory,"56.2700_-5.6300_16_8.json");
	await fsp.writeFile(nearestFile,JSON.stringify(weatherRecord(nearestPosition,{id:"nearest",name:"Nearest harbour",types:["harbour"],category:"Harbour",position:nearestPosition})));
	const requested={latitude:56.271,longitude:-5.631};
	const direct=await app.ajrmMarineWeatherDatabase.resolveNearest({position:requested,weatherDays:16,marineDays:8});
	assert.equal(direct.valid,true);
	assert.equal(direct.locationResolution.contract,"ajrm-marine-weather-location-resolution-v1");
	assert.equal(direct.locationResolution.contractVersion,1);
	assert.equal(direct.locationResolution.mode,"nearest-location");
	assert.equal(direct.locationResolution.selectedLocation.name,"Nearest harbour");
	assert.equal(direct.locationResolution.cacheFallback,false);
	const selectedHour=app.ajrmMarineWeatherDatabase.forecastAt("2026-08-23T10:20:00Z");
	assert.equal(selectedHour.available,true);
	assert.equal(selectedHour.current.at,"2026-08-23T10:00Z");
	assert.equal(selectedHour.contextLocation.name,"Nearest harbour");
	assert.ok(direct.locationResolution.distanceMetres>0);
	assert.equal(fetchCalls,0,"a recent exact-location cache must avoid provider access");

	await fsp.rm(nearestFile);
	const cachedPosition={latitude:56.5,longitude:-5.3};
	await fsp.writeFile(path.join(providerDirectory,"56.5000_-5.3000_16_8.json"),JSON.stringify(weatherRecord(cachedPosition,{id:"cached",name:"Cached marina",types:["marina"],category:"Marina",position:cachedPosition})));
	fetchMode="pending"; pendingRejects=[];
	const providerStarted=new Promise((resolve)=>{providerStartedResolve=resolve;});
	let fallbackSettled=false;
	const fallbackPromise=app.ajrmMarineWeatherDatabase.resolveNearest({position:requested,weatherDays:16,marineDays:8});
	fallbackPromise.then(()=>{fallbackSettled=true;},()=>{fallbackSettled=true;});
	let providerStartTimer;
	try{await Promise.race([providerStarted,new Promise((_resolve,reject)=>{providerStartTimer=setTimeout(()=>reject(new Error("provider calls did not start")),1000);})]);}
	finally{clearTimeout(providerStartTimer);}
	await new Promise((resolve)=>setImmediate(resolve));
	assert.equal(fallbackSettled,false,"a different cached point must not be selected while the provider attempt is pending");
	for(const reject of pendingRejects)reject(new Error("Pi offline"));
	const fallback=await fallbackPromise;
	assert.equal(fetchCalls,2,"both provider requests must be attempted before alternate-cache selection");
	assert.equal(fallback.valid,true);
	assert.equal(fallback.locationResolution.mode,"nearest-cached-location");
	assert.equal(fallback.locationResolution.selectedLocation.name,"Cached marina");
	assert.deepEqual(fallback.locationResolution.selectedLocation.position,cachedPosition);
	assert.equal(fallback.locationResolution.cacheFallback,true);
	assert.match(fallback.locationResolution.fallbackReason,/Pi offline/);
	assert.ok(fallback.locationResolution.distanceMetres>1000);
	assert.equal(fallback.source.cache,"nearest-fallback");
	assert.equal(fallback.hourly.forecast.hourly.time.length,1);

	fetchMode="fail";
	const routes=new Map(); const router={get(route,handler){routes.set(`GET ${route}`,handler);},post(route,handler){routes.set(`POST ${route}`,handler);}}; plugin.registerWithRouter(router);
	assert.equal(typeof routes.get("GET /weather/nearest"),"function");
	const response={statusCode:200,status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;}};
	await routes.get("GET /weather/nearest")({method:"GET",query:{latitude:String(requested.latitude),longitude:String(requested.longitude),weatherDays:"16",marineDays:"8"}},response);
	assert.equal(response.statusCode,200); assert.equal(response.body.locationResolution.mode,"nearest-cached-location");
	const invalidResponse={statusCode:200,status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;}};
	await routes.get("GET /weather/nearest")({method:"GET",query:{}},invalidResponse);
	assert.equal(invalidResponse.statusCode,400); assert.match(invalidResponse.body.error,/latitude and longitude/);
	assert.ok(plugin.getOpenApi().paths["/weather/nearest"]);
});
