/** Weather Database webapp: provider status plus named, cached forecast inspection. */

import { renderForecastTable } from "./weather-forecast-view.mjs?v=0.1.9";
import { filterWeatherLocations } from "./weather-location-search.mjs?v=0.1.9";

const apiBase = "/plugins/signalk-ajrm-marine-weather-database";
const selectedLocationKey = "ajrmMarineWeatherDatabaseSelectedLocation";
const $ = (id) => document.getElementById(id);
let allWeatherLocations = [];

async function requestJson(url, options = {}) {
	const response = await fetch(url, { headers:{ "Content-Type":"application/json" }, ...options });
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
	return body;
}

function setBusy(button, busy, text) {
	if (busy) {
		if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
		button.textContent = text;
		button.disabled = true;
		button.classList.add("is-working");
	} else {
		button.textContent = button.dataset.idleText || button.textContent;
		button.disabled = false;
		button.classList.remove("is-working");
	}
}

function forecastDescription(result, rowCount) {
	const location = result.contextLocation?.name || "Selected location";
	const source = result.source?.provider || result.source?.providerId || "weather provider";
	const fetchedAt = result.source?.fetchedAt ? new Date(result.source.fetchedAt).toLocaleString() : "unknown time";
	const cache = result.source?.cache || "unknown cache state";
	const fallback = result.source?.fallbackReason ? ` · offline fallback: ${result.source.fallbackReason}` : "";
	return `${location} · ${rowCount} hourly rows · ${source} · fetched ${fetchedAt} · ${cache}${fallback}`;
}

async function loadStatus() {
	setBusy($("refresh"), true, "Refreshing…");
	try {
		const status = await requestJson(`${apiBase}/status`);
		$("summary").textContent = `${status.cacheEntries} durable cache entries · ${status.weatherLocationCount} weather locations · v${status.version}`;
		$("providers").replaceChildren(...status.providers.map((provider) => {
			const row = document.createElement("tr");
			for (const value of [provider.name, provider.enabled ? "Yes" : "No", provider.configured ? "Yes" : "No", provider.cacheEntries, provider.capabilities.join(", ")]) {
				const cell=document.createElement("td"); cell.textContent=value; row.append(cell);
			}
			return row;
		}));
		$("latest").textContent = status.latest ? JSON.stringify(status.latest, null, 2) : "No forecast has been requested yet.";
	} catch (error) { $("summary").textContent = error.message; }
	finally { setBusy($("refresh"), false); }
}

function renderLocations() {
	const locations = filterWeatherLocations(allWeatherLocations, $("locationSearch").value);
	const selected = localStorage.getItem(selectedLocationKey) || "";
	const select = $("weatherLocation");
	select.replaceChildren(new Option("Select a port, anchorage, gate or forecast point…", ""));
	const groups = new Map();
	for (const location of locations) {
		const category = location.category || "Weather location";
		if (!groups.has(category)) {
			const group = document.createElement("optgroup");
			group.label = category;
			groups.set(category, group);
			select.append(group);
		}
		groups.get(category).append(new Option(location.name, location.id));
	}
	if (locations.some((location) => location.id === selected)) $("weatherLocation").value = selected;
	$("locationSearchStatus").textContent = `${locations.length} of ${allWeatherLocations.length} locations shown`;
	return locations;
}

async function loadLocations() {
	allWeatherLocations = await requestJson(`${apiBase}/locations`);
	const locations = renderLocations();
	return locations;
}

async function loadForecast(force = false) {
	const locationId = $("weatherLocation").value;
	if (!locationId) {
		$("forecastStatus").textContent = "Select a weather location first.";
		return;
	}
	localStorage.setItem(selectedLocationKey, locationId);
	const button = force ? $("refreshForecast") : $("loadForecast");
	setBusy(button, true, force ? "Refreshing…" : "Loading…");
	$("forecastStatus").textContent = force ? "Refreshing weather and marine forecasts from enabled providers…" : "Loading the stored forecast…";
	try {
		const result = force
			? await requestJson(`${apiBase}/weather/refresh`, { method:"POST", body:JSON.stringify({ locationId, weatherDays:16, marineDays:8 }) })
			: await requestJson(`${apiBase}/weather/status?locationId=${encodeURIComponent(locationId)}&weatherDays=16&marineDays=8`);
		if (!result.valid) throw new Error(result.error || "No usable forecast is available.");
		const rowCount = renderForecastTable($("forecastTable"), result);
		$("forecastStatus").textContent = forecastDescription(result, rowCount);
		$("latest").textContent = JSON.stringify({ ...result, hourly:undefined }, null, 2);
		await loadStatus();
	} catch (error) {
		$("forecastStatus").textContent = error.message;
	} finally { setBusy(button, false); }
}

$("refresh").addEventListener("click", loadStatus);
$("loadForecast").addEventListener("click", () => loadForecast(false));
$("refreshForecast").addEventListener("click", () => loadForecast(true));
$("weatherLocation").addEventListener("change", () => {
	localStorage.setItem(selectedLocationKey, $("weatherLocation").value);
	if ($("weatherLocation").value) loadForecast(false);
});
$("locationSearch").addEventListener("input", renderLocations);

async function start() {
	await Promise.all([loadStatus(), loadLocations()]);
	if ($("weatherLocation").value) await loadForecast(false);
}

start().catch((error) => { $("forecastStatus").textContent = error.message; });
