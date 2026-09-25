import { buildCatalog, CatalogRows } from './catalog.builder';

const rows: CatalogRows = {
  types: [
    { id: 'child', simpleName: 'Child doctor', properName: 'Pediatrics', icon: 'child_care', sort: 2, isCommon: true },
    { id: 'general', simpleName: 'General doctor', properName: 'General Medicine', icon: 'x', sort: 1, isCommon: true },
    { id: 'heart', simpleName: 'Heart doctor', properName: 'Cardiology', icon: 'y', sort: 3, isCommon: false },
  ],
  problems: [{ id: 'fever', name: 'Fever', icon: 'thermostat', isDanger: false, sort: 1 }],
  problemMap: [
    { problemId: 'fever', typeId: 'heart', audience: 'adult', rank: 2 },
    { problemId: 'fever', typeId: 'general', audience: 'adult', rank: 1 },
    { problemId: 'fever', typeId: 'child', audience: 'child', rank: 1 },
  ],
  kinds: [{ id: 'snake', name: 'Snake bite', detail: 'Any snake bite', icon: 'pest', sort: 1 }],
  kindTypes: [{ kindId: 'snake', typeId: 'general' }],
  firstAid: [],
  config: [
    { key: 'platform_fee_percent', value: 10 },
    { key: 'emergency_charge_percent', value: 20 },
    { key: 'payout_hold_hours', value: 24 },
    { key: 'bookings.enabled', value: true },
    { key: 'min_supported_app_version', value: '1.0.0' },
  ],
};

describe('buildCatalog', () => {
  const c = buildCatalog(rows);

  it('orders types and lists the common ones', () => {
    expect(c.doctorTypes.map((t) => t.id)).toEqual(['general', 'child', 'heart']);
    expect(c.commonTypeIds).toEqual(['general', 'child']);
  });

  it('gives each problem its doctors for adults and children, best first', () => {
    expect(c.healthProblems[0]).toMatchObject({ id: 'fever', adultTypeIds: ['general', 'heart'], childTypeIds: ['child'] });
  });

  it('has no first aid until a page is published', () => {
    expect(c.emergencyKinds[0]).toMatchObject({ id: 'snake', typeIds: ['general'], firstAid: null });
  });

  it('shows public rules and switches only', () => {
    expect(c.rules).toEqual({ platformFeePercent: 10, emergencyChargePercent: 20 });
    expect(c.switches).toEqual({ bookings: true });
    expect(JSON.stringify(c)).not.toContain('payout_hold_hours');
    expect(c.app.minSupportedVersion).toBe('1.0.0');
  });
});
