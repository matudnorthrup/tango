import {
  ensureFleetDailyLog,
  type TangoProfilePathOptions,
} from "@tango/core";
import type { DeterministicHandler } from "@tango/core";

export interface FleetDailyLogBootstrapOptions extends TangoProfilePathOptions {
  profileRoot?: string;
  now?: Date;
  timeZone?: string;
}

export function createDailyLogBootstrapHandler(
  options: FleetDailyLogBootstrapOptions = {},
): DeterministicHandler {
  return async () => {
    const result = ensureFleetDailyLog(options);
    return {
      status: "ok",
      summary: result.created
        ? `Fleet daily log created for ${result.date}`
        : `Fleet daily log verified for ${result.date}`,
      data: { ...result },
    };
  };
}
