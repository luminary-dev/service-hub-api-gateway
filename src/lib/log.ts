// This service's logger instance. The logging module itself is canonical —
// identical in every service; only this name differs.
import { createLogger } from "./logging";

export const log = createLogger("api-gateway");
