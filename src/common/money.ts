/** Money travels as whole paise, with a ready-made label for the app: { paise: 30000, display: '₹300' }. */
export interface Money {
  paise: number;
  display: string;
}

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 });

export function money(paise: number): Money {
  return { paise, display: `₹${inr.format(paise / 100)}` };
}

/** OPflow's share of a doctor's fee. The database checks the same formula (bookings_fee_split). */
export function platformFee(feePaise: number, percent = 10): number {
  return Math.floor((feePaise * percent) / 100);
}

/** Emergency consultation charge on top of the fee, rounded to whole rupees. All of it is OPflow's. */
export function emergencyCharge(feePaise: number, percent: number): number {
  return Math.round((feePaise * percent) / 100 / 100) * 100;
}
