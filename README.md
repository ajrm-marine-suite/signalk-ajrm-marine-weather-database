# AJRM Marine Weather Database

A standalone Signal K weather database for AJRM Marine Suite. It owns network-provider access, durable offline caches, freshness, provenance and forecast selection. Location Editor remains the spatial catalogue; Display and Marine Planning consume this service.

Version `0.1.13` adds a provider-neutral service method for selecting a
normalized retained forecast hour, used by Instruments' Hour back and Hour
forward controls. Optional, isolated past-day forecast requests retain their
normal
default of `pastDays: 0`; Marine Planning asks for one past day so its
current-day table can begin at Europe/London midnight during BST. Weather and
marine provider timestamps remain in GMT, and the current summary still uses
the hour nearest now rather than a retained historical hour.

The webapp lists dedicated forecast points plus every harbour, marina,
anchorage, mooring, tidal gate, standard tidal port and secondary tidal port held by
Location Editor. The selector groups them by kind so similarly named records
remain distinguishable. Selecting one displays the same concise hourly weather/marine columns used by
Marine Planning's **Fetched Weather** tab. Selection is remembered in the
browser. The live search matches location names, kinds and descriptions.
**Load forecast** reuses a fresh provider cache and refreshes provider-stale or
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

Whole-forecast cache provenance follows the selected primary hourly provider.
A secondary provider may supply an explicitly recorded missing current field,
but its cached state does not turn a live primary forecast into a cached
forecast in consumer wording.

This makes later provider additions additive rather than a replacement for Open-Meteo. A future consensus/ensemble policy can be added as a named policy without changing stored provider records.

## Offline operation

Provider records are stored separately on disk. Each provider owns its refresh
period; Open-Meteo defaults to one hour and is separately configurable. Fresh
cache entries avoid a network call. Open-Meteo's combined weather/marine request
has a 15-second deadline, including response-body parsing, so a blackholed
connection cannot prevent fallback. If refresh fails or times out, the stored
entry remains available indefinitely as an explicit offline fallback with its
age and failure reason. Forecast age is labelled; consumers use Warning after
24 hours and Danger after 72 hours rather than discarding the record.

Requests for the same provider and rounded coordinate/horizon cache key share
one in-flight refresh. Persistent writes use a unique temporary file followed
by atomic replacement, so overlapping browser clients cannot make an otherwise
successful provider result fail during cache rename.

The optional `pastDays` request field is bounded from 0 to 7 and defaults to 0.
It is sent to both the atmospheric and marine provider calls. Each history
horizon has its own cache filename and cache context, and nearest-cache fallback
requires an exact `pastDays` match. Existing cache files have no history suffix
and remain valid only for the default present-only request. This prevents a
Planning history request from changing or contaminating another consumer's
normal forecast cache.

Display can request weather for a resolved fresh or last-known vessel position through
`GET /weather/nearest?latitude=…&longitude=…`. Weather Database selects the
nearest eligible Locations record independently of any tide or tidal-gate
selection. The projection includes `locationResolution`, which identifies the
requested position, selected weather location and position, distance in metres,
selection mode and any cache fallback reason.

Nearest-location resolution keeps the requested place authoritative in this
fixed order: reuse a recent exact-location cache; otherwise ask the provider;
use an older exact-location cache if that attempt fails; and only
then select the nearest different stored cached coordinate group. Provider
priority is preserved within that one group and provider records from different
locations are never combined. New cache records retain the request position and
a non-authoritative snapshot of the Locations context for offline
identification, while legacy coordinate filenames remain usable for fallback
selection.

## Signal K contracts

- `app.ajrmMarineWeatherDatabase`: `ajrm-marine-weather-database-service-v1`,
  including the additive `resolveNearest(request)` operation
- selectable forecast locations: Location Editor records classified as
  `weatherForecastLocation`, `harbour`, `marina`, `anchorage`, `mooring`,
  `tidalStandardPort`, `tidalSecondaryPort` or `tidalGate`
- projection: `ajrm-marine-weather-projection-v2`
- nearest-location metadata: `ajrm-marine-weather-location-resolution-v1`
- diagnostics: `app.ajrmMarineWeatherDiagnostics`
- compact Signal K path: `plugins.ajrmMarineWeatherDatabase.weather`

`POST /weather/refresh` forces provider and persistent-cache mutation and
therefore requires an authenticated Signal K principal with `readwrite` or
`admin` permission. Read-only status, location and nearest-weather routes remain
available to normal Signal K webapp clients.

`pastDays` is accepted by `GET /weather/status`, `GET /weather/nearest` and
`POST /weather/refresh`. Omitting it preserves the present-only behaviour.

Forecast speeds and angles use Signal K SI units. Provider-native hourly
payloads are retained as explicit provenance and for current Planning detail views.

## Install

```sh
cd ~/.signalk
npm install git+https://github.com/ajrm-marine-suite/signalk-ajrm-marine-weather-database.git#v0.1.13 --omit=dev --no-package-lock
sudo systemctl restart signalk
```

Open **Webapps → AJRM Marine Weather Database** and hard-refresh after
upgrading.

## Development

```sh
npm install
npm test
npm pack --dry-run
```

## Attribution

AJRM Marine Weather Database is authored and maintained by Anthony McDonald,
with assistance from William McAusland. It builds on the Signal K project and
the work of Signal K plugin authors. Open-Meteo supplies the initial atmospheric
and marine provider data under its published terms and attribution requirements.

## License and commercial use

This software is licensed under the GNU Affero General Public License v3.0 or
later (AGPL-3.0-or-later). You may use, study, share, and modify it under that
licence. If you modify it and make it available to users over a network, the
corresponding source code must also be made available under the AGPL.

Commercial licensing is available by arrangement for organisations that want
different terms.

## Alpha safety disclaimer

> This software is Alpha Release and has not been tested in live environments and must not be relied upon for navigation or safety. The Authors do not accept any responsibility for loss or damage as a result of using this software.

## Alpha Release

Provider-neutral weather and marine forecast caching for the AJRM Marine Suite.

Development assistance: OpenAI Codex helped with code generation, refactoring,
and automated testing during the alpha development cycle.
