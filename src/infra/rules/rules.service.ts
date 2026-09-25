import { HttpStatus, Injectable } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error';
import { DbService } from '../db/db.service';

const CACHE_MS = 15_000;

/**
 * The rulebook (`app_config`): fee %, cut-offs, hold minutes, kill switches. Read often, changed rarely by
 * admins, so each process keeps a 15-second copy. A kill switch therefore takes effect everywhere within
 * about 15 seconds.
 */
@Injectable()
export class RulesService {
  private cache?: { at: number; values: Map<string, unknown> };
  private inflight?: Promise<Map<string, unknown>>;

  constructor(private readonly dbs: DbService) {}

  async all(): Promise<Map<string, unknown>> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.values;
    this.inflight ??= this.dbs.db
      .selectFrom('appConfig')
      .select(['key', 'value'])
      .execute()
      .then((rows) => {
        const values = new Map(rows.map((r) => [r.key, r.value as unknown]));
        this.cache = { at: Date.now(), values };
        return values;
      })
      .finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  private async num(key: string, fallback: number): Promise<number> {
    const v = (await this.all()).get(key);
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  }

  private async flag(key: string, fallback: boolean): Promise<boolean> {
    const v = (await this.all()).get(key);
    return typeof v === 'boolean' ? v : fallback;
  }

  private async text(key: string, fallback: string | null): Promise<string | null> {
    const v = (await this.all()).get(key);
    return typeof v === 'string' ? v : fallback;
  }

  platformFeePercent = () => this.num('platform_fee_percent', 10);
  emergencyChargePercent = () => this.num('emergency_charge_percent', 20);
  rescheduleCutoffMinutes = () => this.num('reschedule_cutoff_minutes', 120);
  rescheduleMax = () => this.num('reschedule_max', 1);
  holdMinutes = () => this.num('hold_minutes', 10);
  maxOpenHolds = () => this.num('max_open_holds', 2);
  payoutHoldHours = () => this.num('payout_hold_hours', 24);
  noShowAfterMinutes = () => this.num('no_show_after_minutes', 60);
  movePickHours = () => this.num('move_pick_hours', 48);
  doctorMaxDevices = () => this.num('doctor.max_devices', 2);
  minAppVersion = () => this.text('min_supported_app_version', '1.0.0');
  latestAppVersion = () => this.text('latest_app_version', '1.0.0');
  maintenanceMessage = () => this.text('maintenance.message', null);
  bookingsEnabled = () => this.flag('bookings.enabled', true);
  emergencyEnabled = () => this.flag('emergency.enabled', true);
  emergencyConsultEnabled = () => this.flag('emergency_consult.enabled', true);
  turnAlertsEnabled = () => this.flag('push.turn_alerts', true);

  /** Throws the right simple-English error when a kill switch is off. */
  async requireBookingsOn(): Promise<void> {
    if (!(await this.bookingsEnabled())) {
      throw new AppError('BOOKINGS_OFF', 'Booking is stopped for a short time. Please try again later.', HttpStatus.SERVICE_UNAVAILABLE, true);
    }
  }

  async requireEmergencyConsultOn(): Promise<void> {
    if (!(await this.emergencyConsultEnabled())) {
      throw new AppError('EMERGENCY_CONSULT_OFF', 'Emergency consultation is stopped for a short time. Please call 108 if it is serious.', HttpStatus.SERVICE_UNAVAILABLE, true);
    }
  }
}

/** '1.10.0' > '1.9.3'. Non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
