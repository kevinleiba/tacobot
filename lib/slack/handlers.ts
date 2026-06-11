import { getBoltApp } from "./bolt";
import { registerMessageHandler } from "./handlers/message";
import { registerReactionHandler } from "./handlers/reaction";
import { registerCommandHandlers } from "./handlers/commands";
import { registerUserSyncHandlers } from "./handlers/userSync";
import { registerOrderActionHandlers } from "./handlers/orderActions";

let registered = false;

/**
 * Register all Bolt handlers exactly once. Lazy so route modules can be
 * imported during build without instantiating the App (which needs secrets).
 */
export function registerAllHandlers(): void {
  if (registered) return;
  registered = true;
  const app = getBoltApp();
  registerMessageHandler(app);
  registerReactionHandler(app);
  registerCommandHandlers(app);
  registerUserSyncHandlers(app);
  registerOrderActionHandlers(app);
}
