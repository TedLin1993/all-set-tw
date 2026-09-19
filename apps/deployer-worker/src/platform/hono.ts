import { createFactory } from "hono/factory";
import type { AppBindings } from "./env";

export const honoFactory = createFactory<AppBindings>();
