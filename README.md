# AJRM Marine Weather Database

A standalone Signal K weather database for AJRM Marine Suite. It owns network-provider access, durable offline caches, freshness, provenance and forecast selection. Location Editor remains the spatial catalogue; Display and Marine Planning consume this service.

The webapp lists dedicated forecast points plus every harbour, marina,
anchorage, mooring, tidal gate, standard tidal port and secondary tidal port held by
Location Editor. The selector groups them by kind so similarly named records
remain distinguishable. Selecting one displays the same concise hourly weather/marine columns used by
Marine Planning's **Fetched Weather** tab. Selection is remembered in the
browser. **Load forecast** reuses a fresh provider cache and refreshes stale or
missing data; **Refresh forecast** explicitly asks every enabled provider for a
new forecast. Provider data remain in Weather Database, never in Locations.

## Provider architecture

The first adapter is Open-Meteo, covering atmospheric and marine hourly forecasts. The registry can run multiple enabled providers **simultaneously**. Each provider has its own cache and failure state. The resolver:

1. refreshes all enabled/configured providers concurrently;
2. preserves every provider result in `sources`;
3. selects one primary hourly series by configured priority;
4. fills only missing current fields from the next usable provider;
5. records the selected provider for every field; and
6. never silently averages forecasts.

This makes later provider additions additive rather than a replacement for Open-Meteo. A future consensus/ensemble policy can be added as a named policy without changing stored provider records.

## Offline operation

Provider records are stored separately on disk. Fresh cache entries avoid a network call. If refresh fails, a non-expired entry is returned as an explicit offline fallback with the failure reason. Expired data remain visible in database diagnostics but are not presented as a valid forecast.

## Signal K contracts

- `app.ajrmMarineWeatherDatabase`: `ajrm-marine-weather-database-service-v1`
- selectable forecast locations: Location Editor records classified as
  `weatherForecastLocation`, `harbour`, `marina`, `anchorage`, `mooring`,
  `tidalStandardPort`, `tidalSecondaryPort` or `tidalGate`
- projection: `ajrm-marine-weather-projection-v2`
- diagnostics: `app.ajrmMarineWeatherDiagnostics`
- compact Signal K path: `plugins.ajrmMarineWeatherDatabase.weather`

Forecast speeds and angles use Signal K SI units. Provider-native hourly
payloads are retained as explicit provenance and for current Planning detail views.

## Install

```sh
cd ~/.signalk
npm install git+https://github.com/ajrm-marine-suite/signalk-ajrm-marine-weather-database.git#v0.1.6 --omit=dev --no-package-lock
sudo systemctl restart signalk
```
