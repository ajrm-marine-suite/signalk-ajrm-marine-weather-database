/** Verifies Signal K lifecycle, service registration, status publication and public icon packaging. */
const assert=require("node:assert/strict"); const fs=require("node:fs"); const fsp=require("node:fs/promises"); const os=require("node:os"); const path=require("node:path"); const test=require("node:test");
const createPlugin=require("../plugin/index.cjs");
test("plugin registers standalone weather service and retracts it on stop",async(t)=>{
	const directory=await fsp.mkdtemp(path.join(os.tmpdir(),"ajrm-weather-plugin-")); t.after(()=>fsp.rm(directory,{recursive:true,force:true}));
	const messages=[]; const app={getDataDirPath:()=>directory,setPluginStatus(){},handleMessage(_id,message){messages.push(message);},subscriptionmanager:{subscribe(){}}};
	const plugin=createPlugin(app); plugin.start({openMeteoEnabled:false});
	assert.equal(app.ajrmMarineWeatherDatabase.contract,"ajrm-marine-weather-database-service-v1");
	assert.equal(globalThis[Symbol.for("mcdonaldajr.ajrmMarineWeatherDatabase")],app.ajrmMarineWeatherDatabase);
	const status=await app.ajrmMarineWeatherDatabase.databaseStatus(); assert.equal(status.contract,"ajrm-marine-weather-database-status-v1"); assert.equal(status.providers[0].enabled,false);
	const publishedStatus=messages.flatMap((message)=>message.updates || []).flatMap((update)=>update.values || []).find((value)=>value.path==="plugins.ajrmMarineWeatherDatabase")?.value;
	assert.equal(publishedStatus.contract,"ajrm-marine-weather-database-status-v1");
	assert.equal(publishedStatus.contractVersion,1);
	assert.equal(publishedStatus.plugin,"signalk-ajrm-marine-weather-database");
	assert.equal(publishedStatus.enabled,true);
	plugin.stop(); assert.equal(app.ajrmMarineWeatherDatabase,undefined); assert.equal(globalThis[Symbol.for("mcdonaldajr.ajrmMarineWeatherDatabase")],undefined);
	assert.ok(messages.some((message)=>message.updates?.some((update)=>update.values?.some((value)=>value.path==="plugins.ajrmMarineWeatherDatabase"))));
});
test("appIcon exists at package root and served public path",()=>{const packageJson=require("../package.json"); assert.equal(packageJson.signalk.appIcon,"./icon-120.png"); for(const file of ["../icon-120.png","../public/icon-120.png"]) assert.ok(fs.statSync(path.join(__dirname,file)).size>100);});
