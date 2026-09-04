function scopedKey(scope, key) {
  return `${scope}:${String(key)}`;
}

const LEGACY_READ_RULES = {
  adsense: {
    exact: new Set([
      "latest-report-v5",
      "latest-repair-report-v1",
      "latest-indexing-report-v1",
      "anti-regression-baseline-v1",
      "anti-regression-state-v1",
      "latest-regression-report-v1",
      "anti-regression-audit-cursor-v2",
      "latest-quality-report-v1",
      "quality-manual-site-v1",
      "indexing-site-cursor-v1",
      "site-guardian-report-v1"
    ]),
    prefixes: ["indexing-cursor-v2:", "live-audit-cursor-v2:"]
  },
  saas: {
    exact: new Set([
      "saas-shell-monitor-report-v4",
      "saas-shell-monitor-status-v4",
      "saas-shell-manual-cursor-v4",
      "functional-health-report-v1",
      "functional-health-cursor-v1",
      "saas-testing-report-v2",
      "saas-testing-status-v2",
      "saas-testing-cursor-v2",
      "saas-alert-report-v1"
    ]),
    prefixes: []
  }
};

function canReadLegacy(scope, key) {
  const rules = LEGACY_READ_RULES[scope];
  if (!rules) return false;
  const value = String(key);
  return rules.exact.has(value) || rules.prefixes.some(prefix => value.startsWith(prefix));
}

function stripScopedList(scope, result) {
  if (!result || !Array.isArray(result.keys)) return result;
  const prefix = `${scope}:`;
  return {
    ...result,
    keys: result.keys
      .filter(item => String(item?.name || "").startsWith(prefix))
      .map(item => ({ ...item, name: String(item.name).slice(prefix.length) }))
  };
}

export function createScopedKV(kv, scope) {
  if (!kv) return kv;
  return {
    async get(key, ...args) {
      const scoped = await kv.get(scopedKey(scope, key), ...args);
      if (scoped !== null && scoped !== undefined) return scoped;
      if (!canReadLegacy(scope, key)) return scoped;
      return kv.get(String(key), ...args);
    },
    put(key, value, ...args) {
      return kv.put(scopedKey(scope, key), value, ...args);
    },
    delete(key) {
      return kv.delete(scopedKey(scope, key));
    },
    async list(options = {}) {
      const prefix = scopedKey(scope, options.prefix || "");
      return stripScopedList(scope, await kv.list({ ...options, prefix }));
    },
    async getWithMetadata(key, ...args) {
      const scoped = await kv.getWithMetadata(scopedKey(scope, key), ...args);
      if (scoped?.value !== null && scoped?.value !== undefined) return scoped;
      if (!canReadLegacy(scope, key)) return scoped;
      return kv.getWithMetadata(String(key), ...args);
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
