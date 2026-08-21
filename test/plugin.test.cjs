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
