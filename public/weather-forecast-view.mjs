/** Renders the read-only hourly weather and marine table shared visually with Marine Planning's Fetched Weather tab. */

export const forecastColumns = [
	["localTime", "Local Time (UK)"],
	["temperature", "Temp (°C)"],
	["wind", "Wind (kn)"],
	["gust", "Gust (kn)"],
	["windDirection", "Wind Dir"],
	["waveHeight", "Wave (m)"],
	["wavePeriod", "Period (s)"],
	["waveDirection", "Wave Dir"],
	["swellHeight", "Swell (m)"],
	["swellPeriod", "Swell (s)"],
	["swellDirection", "Swell Dir"],
];

function numberAt(values, index, digits = 1) {
	const source = values?.[index];
	if (source == null || source === "") return "";
	const value = Number(source);
	return Number.isFinite(value) ? value.toFixed(digits) : "";
}

function cardinal(value) {
	if (value == null || value === "") return "";
	const degrees = Number(value);
	if (!Number.isFinite(degrees)) return "";
	const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
	const normalized = ((degrees % 360) + 360) % 360;
	return `${points[Math.round(normalized / 22.5) % 16]} (${Math.round(normalized)}°)`;
}

function instant(source, timezone) {
	if (!source) return null;
	const hasZone = /(?:Z|[+-]\d\d:\d\d)$/i.test(source);
	const utcProvider = /^(?:UTC|GMT|Etc\/GMT)$/i.test(String(timezone || ""));
	const parsed = Date.parse(hasZone || utcProvider ? (hasZone ? source : `${source}Z`) : source);
	return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function localTime(value, timezone) {
	const date = instant(value, timezone);
	return date ? new Intl.DateTimeFormat("en-GB", {
		timeZone:"Europe/London", weekday:"short", day:"2-digit", month:"short",
		hour:"2-digit", minute:"2-digit", hour12:false,
	}).format(date) : String(value || "");
}

export function forecastRows(projection) {
	const forecast = projection?.hourly?.forecast;
	const marine = projection?.hourly?.marine;
	const hourly = forecast?.hourly;
	const sea = marine?.hourly || {};
	if (!Array.isArray(hourly?.time)) return [];
	return hourly.time.map((time, index) => ({
		localTime:localTime(time, forecast.timezone),
		temperature:numberAt(hourly.temperature_2m, index),
		wind:numberAt(hourly.wind_speed_10m || hourly.windspeed_10m, index),
		gust:numberAt(hourly.wind_gusts_10m || hourly.windgusts_10m, index),
		windDirection:cardinal(hourly.wind_direction_10m?.[index] ?? hourly.winddirection_10m?.[index]),
		waveHeight:numberAt(sea.wave_height, index),
		wavePeriod:numberAt(sea.wave_period, index),
		waveDirection:cardinal(sea.wave_direction?.[index]),
		swellHeight:numberAt(sea.swell_wave_height, index),
		swellPeriod:numberAt(sea.swell_wave_period, index),
		swellDirection:cardinal(sea.swell_wave_direction?.[index]),
	}));
}

export function renderForecastTable(table, projection) {
	const rows = forecastRows(projection);
	table.querySelector("thead").innerHTML = `<tr>${forecastColumns.map(([,label]) => `<th>${label}</th>`).join("")}</tr>`;
	table.querySelector("tbody").replaceChildren(...rows.map((row) => {
		const tr = document.createElement("tr");
		for (const [key] of forecastColumns) {
			const cell = document.createElement("td");
			cell.textContent = row[key];
			tr.append(cell);
		}
		return tr;
	}));
	return rows.length;
}
