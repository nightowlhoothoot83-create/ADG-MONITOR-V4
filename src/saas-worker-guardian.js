import worker from "./saas-worker-v3.js";
import { scopeMonitorEnv } from "./scoped-kv.js";

export default {
  fetch(request, env, ctx) {
    return worker.fetch(request, scopeMonitorEnv(env, "saas"), ctx);
  },
  scheduled(event, env, ctx) {
    return worker.scheduled(event, scopeMonitorEnv(env, "saas"), ctx);
  }
};
