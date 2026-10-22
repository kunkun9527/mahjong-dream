// Injected by build_browser.mjs: the npm assert/util polyfills pulled in by the riichi package read Node's `process`,
// which browsers do not have. esbuild replaces free `process` references inside the bundle with this object only.
export const process = {
  env: {},
  nextTick: (callback, ...args) => queueMicrotask(() => callback(...args)),
};
