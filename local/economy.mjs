// The initial supply and the legacy save upgrade share a one-time marker; never overwrite an already-consumed balance on each login/query.
export const OFFLINE_ECONOMY_VERSION = 1;
export const INITIAL_LOCAL_COINS = 999_999;

export function initializeOfflineEconomy(profile, userData, config) {
  if (Number(profile.offlineEconomyVersion) >= OFFLINE_ECONOMY_VERSION) return false;
  const deltas = config.currencyIds.map((id) => {
    const before = userData.inventoryCount(6, id);
    const after = id === config.coinId ? before * 100 : INITIAL_LOCAL_COINS;
    return { dtype: 6, id, count: after - before };
  });
  // Validate the whole inventory first; if the old balance cannot be scaled safely, do not leave a half-applied migration or write the version marker early.
  userData.changeInventory(deltas);
  profile.coins = INITIAL_LOCAL_COINS;
  profile.ranks = {
    yonma: { ...config.rank },
    sanma: { ...config.rank },
  };
  profile.offlineEconomyVersion = OFFLINE_ECONOMY_VERSION;
  return true;
}
