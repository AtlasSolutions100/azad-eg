import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestIdentity {
  userId: string;
  userName: string;
}

/** Per-request store so audit writes can attribute the acting user without
 * threading identity through every route handler. */
export const auditContext = new AsyncLocalStorage<RequestIdentity>();
