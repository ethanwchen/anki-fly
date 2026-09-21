import type { Env as WorkerEnv } from "../src/index";

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends WorkerEnv {}
  }
}
