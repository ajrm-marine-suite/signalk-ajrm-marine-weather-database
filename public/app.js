/** Weather Database status webapp; deliberately exposes provider provenance rather than hiding it behind a single forecast. */
const $ = (id) => document.getElementById(id);
async function load() {
	$("refresh").disabled = true;
	try {
		const response = await fetch("/plugins/signalk-ajrm-marine-weather-database/status");
		if (!response.ok) throw new Error(`Status returned ${response.status}.`);
		const status = await response.json();
		$("summary").textContent = `${status.cacheEntries} durable cache entries · v${status.version}`;
		$("providers").replaceChildren(...status.providers.map((provider) => {
			const row = document.createElement("tr");
			for (const value of [provider.name, provider.enabled ? "Yes" : "No", provider.configured ? "Yes" : "No", provider.cacheEntries, provider.capabilities.join(", ")]) { const cell=document.createElement("td"); cell.textContent=value; row.append(cell); }
			return row;
		}));
		$("latest").textContent = status.latest ? JSON.stringify(status.latest, null, 2) : "No forecast has been requested yet.";
	} catch (error) { $("summary").textContent = error.message; } finally { $("refresh").disabled = false; }
}
$("refresh").addEventListener("click", load); load();
