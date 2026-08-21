/** Registers independent forecast providers and returns all enabled providers in configured priority order. */

function createProviderRegistry(providers = [], priority = []) {
	const byId = new Map();
	for (const provider of providers) {
		if (!provider?.id || byId.has(provider.id)) throw new Error("Weather providers need unique ids.");
		byId.set(provider.id, provider);
	}
	const order = [...new Set([...priority, ...byId.keys()])].filter((id) => byId.has(id));
	return Object.freeze({
		get: (id) => byId.get(id) || null,
		list: () => order.map((id) => {
			const provider = byId.get(id);
			return { id, name: provider.name, enabled: provider.enabled, configured: provider.configured,
				capabilities: provider.capabilities, persistentCachePermitted: provider.persistentCachePermitted };
		}),
		enabled: () => order.map((id) => byId.get(id)).filter((provider) => provider.enabled && provider.configured),
	});
}

module.exports = { createProviderRegistry };
