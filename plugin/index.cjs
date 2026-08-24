/** Signal K entry point for the provider-neutral weather database, multi-provider resolver and diagnostics service. */

const fs = require("node:fs");
const path = require("node:path");
const { createProviderRegistry } = require("./provider-registry.cjs");
const { createOpenMeteoProvider } = require("./providers/open-meteo.cjs");
const { createWeatherDatabase, validPosition } = require("./database.cjs");
const { primaryFallbackMetadata } = require("./aggregation.cjs");

const packageJson = require("../package.json");
const SERVICE_SYMBOL = Symbol.for("mcdonaldajr.ajrmMarineWeatherDatabase");
const DIAGNOSTICS_SYMBOL = Symbol.for("mcdonaldajr.ajrmMarineWeatherDiagnostics");
const LOCATION_SYMBOL = Symbol.for("mcdonaldajr.ajrmMarineLocations");
const STATUS_PATH = "plugins.ajrmMarineWeatherDatabase";
const WEATHER_PATH = "plugins.ajrmMarineWeatherDatabase.weather";
const WEATHER_LOCATION_TYPES = Object.freeze(new Set([
	"weatherForecastLocation",
	"harbour",
	"marina",
	"anchorage",
	"mooring",
	"tidalStandardPort",
	"tidalSecondaryPort",
	"tidalGate",
]));
const WEATHER_LOCATION_CATEGORIES = Object.freeze([
	["weatherForecastLocation", "Forecast point"],
	["anchorage", "Anchorage"],
	["mooring", "Mooring"],
	["marina", "Marina"],
	["harbour", "Harbour"],
	["tidalSecondaryPort", "Secondary tidal port"],
	["tidalStandardPort", "Standard tidal port"],
	["tidalGate", "Tidal gate"],
]);

function representativePosition(location) {
	const direct = validPosition(location?.position);
	if (direct) return direct;
	const geometry = location?.feature?.geometry;
	if (geometry?.type === "Point" && Array.isArray(geometry.coordinates)) return validPosition({ longitude:geometry.coordinates[0], latitude:geometry.coordinates[1] });
	if (geometry?.type !== "Polygon" || !Array.isArray(geometry.coordinates?.[0]) || !geometry.coordinates[0].length) return null;
	const points = geometry.coordinates[0].map((point) => validPosition({ longitude:point?.[0], latitude:point?.[1] }));
	if (points.some((point) => !point)) return null;
	return validPosition({ longitude:points.reduce((sum, point) => sum + point.longitude, 0) / points.length,
		latitude:points.reduce((sum, point) => sum + point.latitude, 0) / points.length });
}
function distanceMetres(left, right) {
	const earthRadiusMetres = 6371000;
	const latitude1 = left.latitude * Math.PI / 180, latitude2 = right.latitude * Math.PI / 180;
	const deltaLatitude = (right.latitude - left.latitude) * Math.PI / 180;
	const deltaLongitude = (right.longitude - left.longitude) * Math.PI / 180;
	const haversine = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;
	return Math.round(earthRadiusMetres * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine)));
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
			resolveNearest:(request = {}) => resolveNearest(request),
			databaseStatus:() => databaseStatus(), listProviders:() => providers.list(),
			listLocations:() => weatherLocations(),
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
		const readRouter = typeof router.access === "function" ? router.access("readonly") : router;
		const writeRouter = typeof router.access === "function" ? router.access("readwrite") : router;
		readRouter.get("/status", async (_req,res) => res.json(await databaseStatus()));
		readRouter.get("/providers", (_req,res) => res.json(providers?.list?.() || []));
		readRouter.get("/locations", async (_req,res) => res.json(await weatherLocations()));
		readRouter.get("/weather/status", async (req,res) => sendProjection(res, weatherRequest(req), false));
		readRouter.get("/weather/nearest", async (req,res) => sendNearestProjection(res, weatherRequest(req)));
		writeRouter.post("/weather/refresh", write(async (req,res) => sendProjection(res, weatherRequest(req), true)));
	};

	async function sendProjection(res, request, force) {
		try { res.json(await resolve(force ? { ...request, force:true } : request)); }
		catch (error) { res.status(400).json({ error:error.message }); }
	}
	async function sendNearestProjection(res, request) {
		try { res.json(await resolveNearest(request)); }
		catch (error) { res.status(400).json({ error:error.message }); }
	}
	function locationsService() { return app.ajrmMarineLocations || globalThis[LOCATION_SYMBOL] || null; }
	function weatherLocationCategory(location) {
		return WEATHER_LOCATION_CATEGORIES.find(([type]) => location?.types?.includes(type))?.[1] || "Weather location";
	}
	function weatherLocationSummary(location) {
		return { id:location.id || null, name:location.name || "", description:location.description || "",
			types:(location.types || []).filter((type) => WEATHER_LOCATION_TYPES.has(type)),
			category:location.category || weatherLocationCategory(location), position:representativePosition(location), revision:location.revision || null };
	}
	async function weatherLocations() {
		const locations = await locationsService()?.list?.() || [];
		return locations
			.filter((location) => location?.types?.some((type) => WEATHER_LOCATION_TYPES.has(type)))
			.map(weatherLocationSummary)
			.filter((location) => Number.isFinite(location.position?.latitude) && Number.isFinite(location.position?.longitude))
			.sort((left,right) => left.category.localeCompare(right.category) || left.name.localeCompare(right.name));
	}
	async function resolve(request = {}) {
		let contextLocation = null;
		if (request.contextLocationId) {
			const storedLocation = await locationsService()?.get?.(String(request.contextLocationId).split("/").at(-1));
			if (!storedLocation) throw new Error("Weather context location was not found.");
			contextLocation = weatherLocationSummary(storedLocation);
		}
		const result = await database.resolve({ ...request, contextLocation,
			position:request.position || representativePosition(contextLocation) || latestPosition });
		return publishProjection(result);
	}
	async function resolveNearest(request = {}) {
		const requestedPosition = validPosition(request.position);
		if (!requestedPosition) throw new Error("A valid current vessel latitude and longitude are required.");
		const locations = await weatherLocations();
		const selected = nearestLocation(locations, requestedPosition);
		const unavailableReason = selected ? null : "No eligible weather locations are available from Locations.";
		const attempted = selected
			? await database.resolve({ ...request, position:selected.position, contextLocation:selected })
			: await database.resolve({ ...request, position:null, contextLocation:null });
		if (attempted.valid) {
			const fallback = primaryFallbackMetadata(attempted);
			return publishProjection({ ...attempted, locationResolution:locationResolution({ requestedPosition,
				selectedLocation:selected, mode:"nearest-location", cacheFallback:fallback.cacheFallback,
				fallbackReason:fallback.fallbackReason }) });
		}
		const fallbackReason = unavailableReason || attempted.error || "The nearest weather location did not return a usable forecast.";
		const cached = await database.nearestCached({ ...request, position:requestedPosition, fallbackReason });
		if (cached.valid) {
			const cachedLocation = cachedLocationSummary(cached, locations);
			return publishProjection({ ...cached, locationResolution:locationResolution({ requestedPosition,
				selectedLocation:cachedLocation, mode:"nearest-cached-location", cacheFallback:true, fallbackReason }) });
		}
		return publishProjection({ ...attempted, locationResolution:locationResolution({ requestedPosition,
			selectedLocation:selected, mode:"unavailable", cacheFallback:false, fallbackReason }) });
	}
	function nearestLocation(locations, position) {
		return [...locations].sort((left,right) => distanceMetres(position, left.position) - distanceMetres(position, right.position)
			|| left.name.localeCompare(right.name) || String(left.id).localeCompare(String(right.id)))[0] || null;
	}
	function cachedLocationSummary(projection, locations) {
		const position = validPosition(projection.position);
		const context = projection.contextLocation;
		if (context?.name && position) return { id:context.id || null, name:context.name, types:context.types || [],
			category:context.category || "Weather location", position };
		const matching = position ? nearestLocation(locations, position) : null;
		if (matching && distanceMetres(position, matching.position) <= 100) return matching;
		return position ? { id:null, name:`Cached weather at ${position.latitude.toFixed(4)}, ${position.longitude.toFixed(4)}`,
			types:[], category:"Cached forecast", position } : null;
	}
	function locationResolution({ requestedPosition, selectedLocation, mode, cacheFallback, fallbackReason }) {
		const selectedPosition = validPosition(selectedLocation?.position);
		return { contract:"ajrm-marine-weather-location-resolution-v1", contractVersion:1, requestedPosition,
			selectedLocation:selectedLocation && selectedPosition ? { id:selectedLocation.id || null, name:selectedLocation.name || "Weather location",
				types:selectedLocation.types || [], category:selectedLocation.category || "Weather location", position:selectedPosition } : null,
			distanceMetres:selectedPosition ? distanceMetres(requestedPosition, selectedPosition) : null,
			mode, cacheFallback:cacheFallback === true, fallbackReason:fallbackReason || null };
	}
	function publishProjection(result) {
		latestProjection = result;
		publish(WEATHER_PATH, withoutHourly(result));
		return result;
	}
	async function databaseStatus() {
		const stored = database ? await database.status() : { providers:[], cacheEntries:0 };
		const forecastLocations = await weatherLocations();
		return { contract:"ajrm-marine-weather-database-status-v1", contractVersion:1, plugin:plugin.id,
			version:packageJson.version, enabled:running, ...stored, weatherLocationCount:forecastLocations.length,
			locationsService:locationsService()?.contract || null,
			latest:latestProjection ? withoutHourly(latestProjection) : null,
			updatedAt:new Date().toISOString() };
	}
	function weatherRequest(req) {
		const values = req.method === "POST" ? req.body || {} : req.query || {};
		const latitude = values.latitude == null || values.latitude === "" ? NaN : Number(values.latitude);
		const longitude = values.longitude == null || values.longitude === "" ? NaN : Number(values.longitude);
		return { contextLocationId:values.locationId || values.contextLocationId || undefined,
			position:Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude,longitude } : undefined,
			weatherDays:values.weatherDays, marineDays:values.marineDays, pastDays:values.pastDays };
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
	function write(handler) {
		return (req,res,next) => {
			const permission = req.skPrincipal?.permissions;
			if (permission === "admin" || permission === "readwrite" || (permission === undefined && req.skIsAuthenticated !== false)) {
				return handler(req,res,next);
			}
			return res.status(403).json({ error:"Weather Database updates require Signal K read/write or admin access." });
		};
	}
	return plugin;
};
