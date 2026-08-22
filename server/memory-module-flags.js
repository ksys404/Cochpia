export const MEMORY_FEATURE_DEFAULTS = Object.freeze({
  autoExtract: false,
  autoProfileUpdate: false,
  hybridRetrieval: false,
  vectorRetrieval: false,
  episodeGrouping: false,
  proactiveMention: false
});

const flagNames = Object.keys(MEMORY_FEATURE_DEFAULTS);

function parseBoolean(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function resolveMemoryFeatureFlags(source = process.env, overrides = {}) {
  return Object.fromEntries(flagNames.map(name => {
    const envName = `MEMORY_${name.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}`;
    return [name, parseBoolean(overrides[name] ?? source[envName], MEMORY_FEATURE_DEFAULTS[name])];
  }));
}

export function featureEnabled(flags, name) {
  return Boolean(flags && Object.hasOwn(flags, name) && flags[name] === true);
}
