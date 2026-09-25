/** Pure functions that shape catalog rows into the API response (easy to unit-test, no database). */

export interface CatalogRows {
  types: { id: string; simpleName: string; properName: string; icon: string; sort: number; isCommon: boolean }[];
  problems: { id: string; name: string; icon: string; isDanger: boolean; sort: number }[];
  problemMap: { problemId: string; typeId: string; audience: 'adult' | 'child'; rank: number }[];
  kinds: { id: string; name: string; detail: string; icon: string; sort: number }[];
  kindTypes: { kindId: string; typeId: string }[];
  firstAid: {
    kindId: string;
    intro: string | null;
    signs: string[];
    callNowIf: string[];
    dos: string[];
    donts: string[];
    sources: unknown;
    reviewedByDoctor: string | null;
    reviewedAt: Date | null;
  }[];
  config: { key: string; value: unknown }[];
}

/** app_config keys the app may see. Internal ones (payout hold, no-show minutes…) stay on the server. */
const PUBLIC_RULES: Record<string, string> = {
  platform_fee_percent: 'platformFeePercent',
  reschedule_cutoff_minutes: 'rescheduleCutoffMinutes',
  reschedule_max: 'rescheduleMax',
  hold_minutes: 'holdMinutes',
  emergency_charge_percent: 'emergencyChargePercent',
};
const PUBLIC_SWITCHES: Record<string, string> = {
  'bookings.enabled': 'bookings',
  'emergency.enabled': 'emergency',
  'emergency_consult.enabled': 'emergencyConsult',
  'push.turn_alerts': 'turnAlerts',
};

export function buildCatalog(rows: CatalogRows) {
  const byOrder = <T extends { sort: number }>(a: T, b: T) => a.sort - b.sort;
  const cfg = new Map(rows.config.map((c) => [c.key, c.value]));
  const pick = (map: Record<string, string>) =>
    Object.fromEntries(Object.entries(map).filter(([k]) => cfg.has(k)).map(([k, name]) => [name, cfg.get(k)]));
  const typesFor = (problemId: string, audience: 'adult' | 'child') =>
    rows.problemMap
      .filter((m) => m.problemId === problemId && m.audience === audience)
      .sort((a, b) => a.rank - b.rank)
      .map((m) => m.typeId);
  const firstAid = new Map(rows.firstAid.map((g) => [g.kindId, g]));

  return {
    doctorTypes: [...rows.types].sort(byOrder).map((t) => ({
      id: t.id,
      simpleName: t.simpleName,
      properName: t.properName,
      icon: t.icon,
    })),
    commonTypeIds: [...rows.types].sort(byOrder).filter((t) => t.isCommon).map((t) => t.id),
    healthProblems: [...rows.problems].sort(byOrder).map((p) => ({
      id: p.id,
      name: p.name,
      icon: p.icon,
      isDanger: p.isDanger,
      adultTypeIds: typesFor(p.id, 'adult'),
      childTypeIds: typesFor(p.id, 'child'),
    })),
    emergencyKinds: [...rows.kinds].sort(byOrder).map((k) => {
      const g = firstAid.get(k.id);
      return {
        id: k.id,
        name: k.name,
        detail: k.detail,
        icon: k.icon,
        typeIds: rows.kindTypes.filter((t) => t.kindId === k.id).map((t) => t.typeId),
        // Only doctor-reviewed, published pages. Until then the app shows its bundled copy.
        firstAid: g
          ? {
              intro: g.intro,
              signs: g.signs,
              callNowIf: g.callNowIf,
              dos: g.dos,
              donts: g.donts,
              sources: g.sources,
              reviewedBy: g.reviewedByDoctor,
              reviewedAt: g.reviewedAt,
            }
          : null,
      };
    }),
    rules: pick(PUBLIC_RULES),
    switches: pick(PUBLIC_SWITCHES),
    app: {
      minSupportedVersion: cfg.get('min_supported_app_version') ?? null,
      latestVersion: cfg.get('latest_app_version') ?? null,
      maintenanceMessage: cfg.get('maintenance.message') ?? null,
    },
  };
}

export type Catalog = ReturnType<typeof buildCatalog>;
