# Changelog

## 0.1.12 — 2026-08-24

- Move refresh periods onto individual providers; Open-Meteo's period is
  separately configurable and defaults to one hour.
- Stop expiring stored forecasts. Offline fallback can use any age, carries an
  explicit age label, and reports Warning after 24 hours and Danger after 72.
- Continue labelling the selected forecast location and distance, including
  nearest cached fallbacks.

## 0.1.11 — 2026-08-24

- Add optional `pastDays` requests, defaulting to zero, and pass the bounded
  value to both Open-Meteo weather and marine requests while retaining GMT
  provider timestamps.
- Isolate present-only and past-day responses in distinct cache files and
  contexts; nearest-cache fallback now requires an exact history horizon and
  treats legacy cache files as present-only.
- Let Marine Planning request one past day so its Europe/London current-day
  table can include 00:00 during BST without changing other consumers.
- Keep the current summary tied to the hour nearest now even when the hourly
  payload includes prior-day rows.

## 0.1.10 — 2026-08-23

- Coalesce concurrent refreshes for the same provider/cache key and use unique
  atomic temporary files so overlapping clients cannot race cache replacement.
- Register Signal K read routes through the read-only access router and forced
  refresh through the read/write router, retain a compatibility fallback, and
  enforce read/write or admin access again in the handler guard.
- Base nearest-weather cache fallback metadata on the selected primary hourly
  provider, avoiding a false whole-forecast cached warning when only a
  secondary field provider used cached data.
- Add webapp help and Alpha safety guidance plus complete public attribution,
  licensing, development and installation documentation.

## 0.1.9 — 2026-08-23

- Add nearest-weather resolution for a vessel position independently of tidal
  selection, with explicit selected Location, distance and cache-fallback
  metadata for Display.
- Preserve exact-location priority: reuse a recent cache, otherwise try the
  provider, then use an older exact cache on failure, and only then select a
  different nearest non-expired cached location.
- Keep provider data from different cached coordinates separate, retain
  non-authoritative Location context for offline identification, validate cache
  coordinates strictly and resolve nearest caches correctly across the date
  line.
- Bound each combined Open-Meteo weather/marine request to 15 seconds so a
  blackholed connection reaches the exact- or nearest-cache fallback path.

## 0.1.8 — 2026-08-21

- Make the provider-concurrency test deterministic on slow 32-bit ARM
  emulation instead of relying on host wall-clock timing.

## 0.1.7 — 2026-08-21

- Add live search across selectable weather-location names, kinds and
  descriptions while retaining the grouped selector and remembered choice.

## 0.1.6 — 2026-08-21

- Allow forecasts to be selected for any Location-owned harbour, marina,
  anchorage, mooring, tidal gate, standard tidal port or secondary tidal port as well as
  dedicated weather forecast points.
- Group selectable places by kind so duplicate or similar names remain clear.

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
