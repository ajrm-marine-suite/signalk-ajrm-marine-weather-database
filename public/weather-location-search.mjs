/** Filters the Location-owned places offered by Weather Database's forecast selector. */

function searchableText(location) {
	return [location?.name, location?.category, location?.description, ...(location?.types || [])]
		.filter(Boolean)
		.join(" ")
		.toLocaleLowerCase();
}

export function filterWeatherLocations(locations, query = "") {
	const terms = String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return [...locations];
	return locations.filter((location) => {
		const text = searchableText(location);
		return terms.every((term) => text.includes(term));
	});
}
