# Changelog

## 0.1.5 — 2026-08-21

- Resolve named weather forecast points from Location Editor and expose them
  through the service and web API.
- Add a remembered forecast-location selector, explicit refresh action and the
  same concise hourly weather/marine table used by Planning.
- Reuse provider-separated persistent caches for each selected coordinate.

## 0.1.4 — 2026-08-21

- Publish the explicit weather status contract on the Signal K status path so
  Console preflight and cross-app BITE can validate the running service.

## 0.1.3 — 2026-08-21

- Clarifies that provider-native hourly data is current forecast provenance and
  Planning detail input, rather than a legacy compatibility payload.

## 0.1.2 — 2026-08-21

- Remove the one-time Location Editor weather-cache importer and its legacy cache-shape support.

## 0.1.1 — 2026-08-21

- Correct the pinned reusable Signal K CI workflow reference used for release validation.

## 0.1.0 — 2026-08-21

- Extract Open-Meteo weather and marine forecasts from Location Editor into a standalone durable database.
- Add simultaneous multi-provider refresh, provider-separated caches and explicit priority/null-only field selection.
- Expose provider provenance, freshness, cache diagnostics and a status webapp.
