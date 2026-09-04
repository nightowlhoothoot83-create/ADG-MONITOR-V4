function scopedKey(scope, key) {
  return `${scope}:${String(key)}`;
}

export function createScopedKV(kv, scope) {
  if (!kv) return kv;
  return {
    get(key, ...args) {
      return kv.get(scopedKey(scope, key), ...args);
    },
    put(key, value, ...args) {
      return kv.put(scopedKey(scope, key), value, ...args);
    },
    delete(key) {
      return kv.delete(scopedKey(scope, key));
    },
    list(options = {}) {
      const prefix = scopedKey(scope, options.prefix || "");
      return kv.list({ ...options, prefix });
    },
    getWithMetadata(key, ...args) {
      return kv.getWithMetadata(scopedKey(scope, key), ...args);
    }
  };
}

export function scopeMonitorEnv(env, scope) {
  return {
    ...env,
    MONITOR_SCOPE: scope,
    MONITOR_KV: createScopedKV(env.MONITOR_KV, scope)
  };
}
