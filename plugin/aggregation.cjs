/** Combines simultaneous provider records using explicit priority and null-only field fallback; it never averages forecasts. */

const CURRENT_FIELDS = ["at", "temperatureC", "windSpeedMps", "windGustMps", "windDirectionTrueRad",
	"waveHeightM", "wavePeriodSeconds", "waveDirectionTrueRad", "swellHeightM", "swellPeriodSeconds", "swellDirectionTrueRad"];

function aggregateProviderResults(results, context) {
	const usable = results.filter((entry) => entry.valid);
	if (!usable.length) {
		return { contract: "ajrm-marine-weather-projection-v2", contractVersion: 2, valid: false,
			calculationReferenceAt: context.now, position: context.position, contextLocation: context.contextLocation,
			current: null, hourly: { forecast: null, marine: null }, source: null, sources: results.map(sourceSummary),
			selection: { strategy: "priority-field-fallback-v1", primaryProviderId: null, selectedProviderByField: {} },
			freshness: null, error: results.map((entry) => `${entry.providerName}: ${entry.error}`).join("; ") || "No weather provider is available." };
	}
	const primary = usable[0];
	const current = {};
	const selectedProviderByField = {};
	for (const field of CURRENT_FIELDS) {
		const selected = usable.find((entry) => entry.current?.[field] != null);
		current[field] = selected?.current?.[field] ?? null;
		selectedProviderByField[field] = selected?.providerId || null;
	}
	return {
		contract: "ajrm-marine-weather-projection-v2", contractVersion: 2, valid: true,
		calculationReferenceAt: context.now, position: context.position, contextLocation: context.contextLocation,
		current, hourly: primary.hourly, source: sourceSummary(primary), sources: results.map(sourceSummary),
		selection: { strategy: "priority-field-fallback-v1", primaryProviderId: primary.providerId, selectedProviderByField },
		freshness: primary.freshness, error: "",
	};
}

function sourceSummary(entry) {
	return { providerId: entry.providerId, provider: entry.providerName, valid: entry.valid,
		fetchedAt: entry.fetchedAt || null, cache: entry.cache || null, persistent: entry.persistent === true,
		fallbackReason: entry.fallbackReason || null, freshness: entry.freshness || null, error: entry.error || "" };
}

function primaryFallbackMetadata(projection) {
	const source = projection?.source;
	const cacheFallback = source?.valid !== false && source?.cache === "fallback";
	return { cacheFallback, fallbackReason:cacheFallback ? source.fallbackReason || null : null };
}

module.exports = { aggregateProviderResults, primaryFallbackMetadata };
