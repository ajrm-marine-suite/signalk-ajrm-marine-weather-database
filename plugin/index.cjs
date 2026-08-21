/** Signal K entry point for the provider-neutral weather database, multi-provider resolver and diagnostics service. */

const fs = require("node:fs");
const path = require("node:path");
const { createProviderRegistry } = require("./provider-registry.cjs");
const { createOpenMeteoProvider } = require("./providers/open-meteo.cjs");
const { createWeatherDatabase } = require("./database.cjs");

const packageJson = require("../package.json");
const SERVICE_SYMBOL = Symbol.for("mcdonaldajr.ajrmMarineWeatherDatabase");
const DIAGNOSTICS_SYMBOL = Symbol.for("mcdonaldajr.ajrmMarineWeatherDiagnostics");
const LOCATION_SYMBOL = Symbol.for("mcdonaldajr.ajrmMarineLocations");
const STATUS_PATH = "plugins.ajrmMarineWeatherDatabase";
const WEATHER_PATH = "plugins.ajrmMarineWeatherDatabase.weather";

function representativePosition(location) {
	const geometry = location?.feature?.geometry;
	if (geometry?.type === "Point" && Array.isArray(geometry.coordinates)) return { longitude:Number(geometry.coordinates[0]), latitude:Number(geometry.coordinates[1]) };
	if (geometry?.type !== "Polygon" || !Array.isArray(geometry.coordinates?.[0]) || !geometry.coordinates[0].length) return null;
	const points = geometry.coordinates[0];
	return { longitude:points.reduce((sum, point) => sum + Number(point[0]), 0) / points.length,
		latitude:points.reduce((sum, point) => sum + Number(point[1]), 0) / points.length };
}

module.exports = function ajrmMarineWeatherDatabase(app) {
	const plugin = {};
	const dataDirectory = app.getDataDirPath?.() || path.join(process.cwd(), ".ajrm-weather-database");
	let running = false, database = null, providers = null, latestProjection = null, latestPosition = null;
	let unsubscribes = [];

	plugin.id = "signalk-ajrm-marine-weather-database";
	plugin.name = "AJRM Marine Weather Database";
	plugin.description = "Provider-neutral durable weather cache and multi-provider forecast service";
	plugin.schema = { type:"object", properties:{
		openMeteoEnabled:{ type:"boolean", title:"Enable Open-Meteo weather and marine forecasts", default:true },
		providerPriority:{ type:"string", title:"Provider priority (comma-separated ids)", default:"open-meteo",
			description:"All enabled providers refresh simultaneously. This order selects the primary hourly series and null-only field fallbacks; forecasts are never silently averaged." },
		refreshAfterHours:{ type:"number", title:"Refresh forecasts after (hours)", default:1, minimum:0.25, maximum:24 },
		expiresAfterHours:{ type:"number", title:"Reject cached forecasts older than (hours)", default:24, minimum:1, maximum:168 },
	} };
	plugin.getOpenApi = () => JSON.parse(fs.readFileSync(path.join(__dirname, "openApi.json"), "utf8"));

	plugin.start = (configured = {}) => {
		if (running) return;
		running = true;
		const priority = String(configured.providerPriority || "open-meteo").split(",").map((value) => value.trim()).filter(Boolean);
		providers = createProviderRegistry([createOpenMeteoProvider({ enabled:configured.openMeteoEnabled !== false })], priority);
		database = createWeatherDatabase({ directory:path.join(dataDirectory, "providers"), providers,
			staleAfterHours:Number(configured.refreshAfterHours) || 1, expiresAfterHours:Number(configured.expiresAfterHours) || 24 });
		const service = Object.freeze({
			contract:"ajrm-marine-weather-database-service-v1", contractVersion:1,
			status:(request = {}) => resolve(request), refresh:(request = {}) => resolve({ ...request, force:true }),
			databaseStatus:() => databaseStatus(), listProviders:() => providers.list(),
		});
		app.ajrmMarineWeatherDatabase = service;
		globalThis[SERVICE_SYMBOL] = service;
		const diagnostics = Object.freeze({ contract:"ajrm-marine-weather-database-diagnostics-v1", contractVersion:1,
			snapshot:async () => ({ ...(await databaseStatus()), latestProjection }) });
		app.ajrmMarineWeatherDiagnostics = diagnostics;
		globalThis[DIAGNOSTICS_SYMBOL] = diagnostics;
		subscribePosition();
		publishMetadata();
		app.setPluginStatus?.(`Started v${packageJson.version}; ${providers.enabled().length} enabled provider(s)`);
		publish(STATUS_PATH, {
			contract:"ajrm-marine-weather-database-status-v1",
			contractVersion:1,
			plugin:plugin.id,
			enabled:true,
			version:packageJson.version,
			providers:providers.list(),
			updatedAt:new Date().toISOString(),
		});
	};

	plugin.stop = () => {
		running = false;
		for (const unsubscribe of unsubscribes.splice(0)) unsubscribe?.();
		if (globalThis[SERVICE_SYMBOL] === app.ajrmMarineWeatherDatabase) delete globalThis[SERVICE_SYMBOL];
		if (globalThis[DIAGNOSTICS_SYMBOL] === app.ajrmMarineWeatherDiagnostics) delete globalThis[DIAGNOSTICS_SYMBOL];
		delete app.ajrmMarineWeatherDatabase; delete app.ajrmMarineWeatherDiagnostics;
		publish(STATUS_PATH, null); publish(WEATHER_PATH, null); app.setPluginStatus?.("Stopped");
	};

	plugin.registerWithRouter = (router) => {
		router.get("/status", async (_req,res) => res.json(await databaseStatus()));
		router.get("/providers", (_req,res) => res.json(providers?.list?.() || []));
		router.get("/weather/status", async (req,res) => sendProjection(res, weatherRequest(req), false));
		router.post("/weather/refresh", write(async (req,res) => sendProjection(res, weatherRequest(req), true)));
	};

	async function sendProjection(res, request, force) {
		try { res.json(await resolve(force ? { ...request, force:true } : request)); }
		catch (error) { res.status(400).json({ error:error.message }); }
	}
	function locationsService() { return app.ajrmMarineLocations || globalThis[LOCATION_SYMBOL] || null; }
	async function resolve(request = {}) {
		let contextLocation = null;
		if (request.contextLocationId) {
			contextLocation = await locationsService()?.get?.(String(request.contextLocationId).split("/").at(-1));
			if (!contextLocation) throw new Error("Weather context location was not found.");
		}
		const result = await database.resolve({ ...request, contextLocation,
			position:request.position || representativePosition(contextLocation) || latestPosition });
		latestProjection = result;
		publish(WEATHER_PATH, withoutHourly(result));
		return result;
	}
	async function databaseStatus() {
		const stored = database ? await database.status() : { providers:[], cacheEntries:0 };
		return { contract:"ajrm-marine-weather-database-status-v1", contractVersion:1, plugin:plugin.id,
			version:packageJson.version, enabled:running, ...stored, latest:latestProjection ? withoutHourly(latestProjection) : null,
			updatedAt:new Date().toISOString() };
	}
	function weatherRequest(req) {
		const values = req.method === "POST" ? req.body || {} : req.query || {};
		const latitude = Number(values.latitude), longitude = Number(values.longitude);
		return { contextLocationId:values.locationId || values.contextLocationId || undefined,
			position:Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude,longitude } : undefined,
			weatherDays:values.weatherDays, marineDays:values.marineDays };
	}
	function subscribePosition() {
		if (!app.subscriptionmanager?.subscribe) return;
		const unsubscribe = app.subscriptionmanager.subscribe({ context:"vessels.self", subscribe:[{ path:"navigation.position", period:1000 }] }, unsubscribes, (error) => app.error?.(error), (delta) => {
			for (const update of delta?.updates || []) for (const value of update.values || []) if (value.path === "navigation.position") latestPosition = value.value;
		});
		if (typeof unsubscribe === "function") unsubscribes.push(unsubscribe);
	}
	function withoutHourly(value) { if (!value || typeof value !== "object") return value; const { hourly, ...compact } = value; return compact; }
	function publish(pathName, value) { app.handleMessage?.(plugin.id, { context:"vessels.self", updates:[{ source:{ label:plugin.id }, timestamp:new Date().toISOString(), values:[{ path:pathName, value }] }] }); }
	function publishMetadata() { app.handleMessage?.(plugin.id, { updates:[{ meta:[{ path:WEATHER_PATH, value:{ description:"Provider-neutral weather projection with explicit source selection, provenance and freshness; SI units." } }] }] }); }
	function write(handler) { return (req,res,next) => { if (req.user && req.user.readOnly) return res.status(403).json({ error:"Write access is required." }); return handler(req,res,next); }; }
	return plugin;
};
