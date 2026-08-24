/** Open-Meteo adapter. Fetches atmospheric and marine forecasts and normalizes current values to Signal K SI units. */

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

function valueAt(hourly, key, index) {
	const value = Number(hourly?.[key]?.[index]);
	return Number.isFinite(value) ? value : null;
}

function nearestHourIndex(times, now) {
	if (!Array.isArray(times) || !times.length) return -1;
	const target = Date.parse(now);
	let selected = -1;
	let distance = Infinity;
	for (let index = 0; index < times.length; index += 1) {
		const candidate = Math.abs(Date.parse(`${times[index]}Z`) - target);
		if (Number.isFinite(candidate) && candidate < distance) { selected = index; distance = candidate; }
	}
	return selected;
}

function radians(value) { return Number.isFinite(value) ? value * Math.PI / 180 : null; }
function metresPerSecond(value) { return Number.isFinite(value) ? value * 0.514444 : null; }

function currentSummary(forecast, marine, now) {
	const weatherIndex = nearestHourIndex(forecast?.hourly?.time, now);
	const marineIndex = nearestHourIndex(marine?.hourly?.time, now);
	return {
		at: weatherIndex >= 0 ? `${forecast.hourly.time[weatherIndex]}Z` : null,
		temperatureC: valueAt(forecast?.hourly, "temperature_2m", weatherIndex),
		windSpeedMps: metresPerSecond(valueAt(forecast?.hourly, "wind_speed_10m", weatherIndex)),
		windGustMps: metresPerSecond(valueAt(forecast?.hourly, "wind_gusts_10m", weatherIndex)),
		windDirectionTrueRad: radians(valueAt(forecast?.hourly, "wind_direction_10m", weatherIndex)),
		waveHeightM: valueAt(marine?.hourly, "wave_height", marineIndex),
		wavePeriodSeconds: valueAt(marine?.hourly, "wave_period", marineIndex),
		waveDirectionTrueRad: radians(valueAt(marine?.hourly, "wave_direction", marineIndex)),
		swellHeightM: valueAt(marine?.hourly, "swell_wave_height", marineIndex),
		swellPeriodSeconds: valueAt(marine?.hourly, "swell_wave_period", marineIndex),
		swellDirectionTrueRad: radians(valueAt(marine?.hourly, "swell_wave_direction", marineIndex)),
	};
}

async function responseJson(fetchFn, url, label, signal) {
	const response = await fetchFn(url, { signal });
	if (!response.ok) throw new Error(`${label} returned ${response.status} ${response.statusText}.`);
	return response.json();
}

async function boundedProviderRequest(task, timeoutMs) {
	const controller = new AbortController();
	let timer = null;
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(new Error(`Open-Meteo provider request timed out after ${timeoutMs} ms.`));
			controller.abort();
		}, timeoutMs);
	});
	try { return await Promise.race([Promise.resolve().then(() => task(controller.signal)), timeout]); }
	finally { clearTimeout(timer); controller.abort(); }
}

function createOpenMeteoProvider(options = {}) {
	const fetchFn = options.fetchFn || globalThis.fetch;
	const configuredTimeout = Number(options.timeoutMs);
	const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? Math.max(1, Math.round(configuredTimeout)) : DEFAULT_REQUEST_TIMEOUT_MS;
	return Object.freeze({
		id: "open-meteo", name: "Open-Meteo", enabled: options.enabled !== false,
		configured: typeof fetchFn === "function", persistentCachePermitted: true,
		capabilities: ["atmospheric-hourly", "marine-hourly", "current-summary"],
		async fetch(request) {
			const { position, weatherDays, marineDays, now } = request;
			const requestedPastDays = Number(request.pastDays);
			const pastDays = Number.isFinite(requestedPastDays) ? Math.max(0, Math.min(7, Math.round(requestedPastDays))) : 0;
			const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
			forecastUrl.search = new URLSearchParams({
				latitude: String(position.latitude), longitude: String(position.longitude),
				hourly: "temperature_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m",
				wind_speed_unit: "kn", forecast_days: String(weatherDays), past_days: String(pastDays), timezone: "GMT",
			});
			const marineUrl = new URL("https://marine-api.open-meteo.com/v1/marine");
			marineUrl.search = new URLSearchParams({
				latitude: String(position.latitude), longitude: String(position.longitude),
				hourly: "wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,swell_wave_direction",
				forecast_days: String(marineDays), past_days: String(pastDays), timezone: "GMT",
			});
			return boundedProviderRequest(async (signal) => {
				const [forecast, marine] = await Promise.all([
					responseJson(fetchFn, forecastUrl, "Open-Meteo weather", signal),
					responseJson(fetchFn, marineUrl, "Open-Meteo marine", signal),
				]);
				return { current: currentSummary(forecast, marine, now), hourly: { forecast, marine } };
			}, timeoutMs);
		},
	});
}

module.exports = { createOpenMeteoProvider, currentSummary };
