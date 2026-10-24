import { existsSync } from "node:fs";
import { open } from "node:fs/promises";

const marker = process.env.SUBAGENTURA_E2E_FAIL_CANCEL_MARKER;

if (marker) {
  const probe = await open("/dev/null", "r");
  const prototype = Object.getPrototypeOf(probe);
  const writeFile = prototype.writeFile;

  prototype.writeFile = function (data, ...args) {
    if (existsSync(marker)) {
      const content = Buffer.isBuffer(data) ? data.toString("utf8") : "";
      try {
        if (JSON.parse(content).kind === "cancelled") {
          return Promise.reject(new Error("Injected cancellation journal failure."));
        }
      } catch {
        // Other writes and non-journal payloads pass through unchanged.
      }
    }
    return writeFile.call(this, data, ...args);
  };

  await probe.close();
}
