import worker from "./worker-auto.js";
import { scopeMonitorEnv } from "./scoped-kv.js";

export default {
  fetch(request, env, ctx) {
    return worker.fetch(request, scopeMonitorEnv(env, "adsense"), ctx);
  },
  scheduled(event, env, ctx) {
    return worker.scheduled(event, scopeMonitorEnv(env, "adsense"), ctx);
  }
};
