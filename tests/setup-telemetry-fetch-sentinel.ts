import { installTelemetryFetchSentinel } from "./helpers/telemetry-fetch-sentinel";

if (process.env.PI_TELEMETRY_FETCH_SENTINEL === "1") {
  installTelemetryFetchSentinel();
}
