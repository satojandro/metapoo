//! Pure arithmetic: the drip schedule, the exit tax and the MasterChef accumulator.
//!
//! Every function rounds **down** on what leaves the contract and keeps the remainder
//! in the contract. Nothing here can overflow for any input within the bounds asserted
//! at compile time below; the callers keep the pool inside those bounds.

/// One day in nanoseconds (block time unit).
pub const DAY_NS: u64 = 86_400_000_000_000;
/// Basis-point denominator.
pub const BPS: u128 = 10_000;
/// Share of the pool released per whole day: 10% (owner decision T5).
pub const DRIP_BPS: u128 = 1_000;
/// Exit tax on each unstaked amount: 10%, burned (owner decision T7).
pub const EXIT_TAX_BPS: u128 = 1_000;
/// Whole days processed by one release. 0.9^365 of a pool is about 2·10⁻¹⁷ of it, so a
/// longer gap changes nothing that matters, and the loop stays bounded.
pub const MAX_DRIP_DAYS: u64 = 365;

/// TOILET's lifetime issuance cap (`contracts/toilet`, `CAP`): no stake can exceed it.
pub const TOILET_CAP: u128 = 1_000_000_000_000_000_000_000_000_000;
/// The largest mPOO amount this contract will ever account for: 1 billion tokens at 18
/// decimals. mPOO's live supply was 971,848,387.68 on 28 Oct 2026 (economy v1, table
/// "mPOO total supply"). Inflow above this bound is left unaccounted, never counted.
pub const MPOO_BOUND: u128 = 1_000_000_000_000_000_000_000_000_000;

/// Fixed-point scale of `acc_per_share` (mPOO per staked TOILET unit).
///
/// Derived from the two largest values that are multiplied by it:
/// - `release × ACC_SCALE`, with `release ≤ pool ≤ MPOO_BOUND`;
/// - `(delta % ACC_SCALE) × stake`, with `stake ≤ TOILET_CAP`.
///
/// `u128::MAX / 10^27 ≈ 3.4·10^11`, so 10^11 is the largest power of ten that fits.
pub const ACC_SCALE: u128 = 100_000_000_000;
const _: () = assert!(MPOO_BOUND <= u128::MAX / ACC_SCALE);
const _: () = assert!(TOILET_CAP <= u128::MAX / ACC_SCALE);

/// Time over which the whole pool would drain at the day-one rate: 10 days.
/// The partial-day release is `pool × rest / DRIP_PERIOD_NS`.
pub const DRIP_PERIOD_NS: u128 = (DAY_NS as u128) * BPS / DRIP_BPS;
const _: () = assert!(((DAY_NS as u128) * BPS).is_multiple_of(DRIP_BPS));
// `(pool % DRIP_PERIOD_NS) × rest` with `rest < DAY_NS` must fit.
const _: () = assert!(DRIP_PERIOD_NS <= u128::MAX / (DAY_NS as u128));
const _: () = assert!(DRIP_BPS > 0 && DRIP_BPS <= BPS && EXIT_TAX_BPS <= BPS);

/// `amount × bps / 10_000`, rounded down, without forming `amount × bps`.
pub fn bps_of(amount: u128, bps: u128) -> u128 {
    (amount / BPS) * bps + (amount % BPS) * bps / BPS
}

/// `a × b / d`, rounded down, for `b < d` and `d × d ≤ u128::MAX`: exact, no overflow.
fn mul_div_small(a: u128, b: u128, d: u128) -> u128 {
    debug_assert!(b < d);
    (a / d) * b + (a % d) * b / d
}

/// What a single release over `elapsed` ns takes from `pool` (spec S2):
/// for each whole day (at most `MAX_DRIP_DAYS`) take `pool / 10` and subtract it before
/// the next day; for the rest of a day take `pool × rest / (10 × DAY_NS)`.
///
/// Always `≤ pool`. Splitting an interval into several releases never releases more than
/// one release over the whole interval (each split compounds on a smaller pool).
pub fn drip(pool: u128, elapsed: u64) -> u128 {
    let mut left = pool;
    let whole_days = elapsed / DAY_NS;
    for _ in 0..whole_days.min(MAX_DRIP_DAYS) {
        let day = bps_of(left, DRIP_BPS);
        if day == 0 {
            break;
        }
        left -= day;
    }
    if whole_days <= MAX_DRIP_DAYS {
        let rest = u128::from(elapsed % DAY_NS);
        left -= mul_div_small(left, rest, DRIP_PERIOD_NS);
    }
    pool - left
}

/// Split a release over `total_staked` units. Returns `(acc increment, charged)`.
///
/// `charged = ceil(inc × total / ACC_SCALE) ≤ release`: the most the stakers can ever
/// claim from this increment, so the pool is charged that and keeps `release - charged`
/// as dust. Charging the ceiling (not the floor) is what makes the sum of all stakers'
/// rounded-down claims never exceed what left the pool, over any number of releases.
pub fn split_release(release: u128, total_staked: u128) -> (u128, u128) {
    if release == 0 || total_staked == 0 {
        return (0, 0);
    }
    let inc = release * ACC_SCALE / total_staked;
    let product = inc * total_staked; // ≤ release × ACC_SCALE: fits.
    let charged = product / ACC_SCALE + u128::from(!product.is_multiple_of(ACC_SCALE));
    (inc, charged)
}

/// Rewards earned by `stake` while the accumulator moved by `delta` (scaled), rounded
/// down: `floor(stake × delta / ACC_SCALE)`, exact, without forming `stake × delta`.
///
/// The result is at most what the contract owes in total, so it fits; `None` would mean
/// an accounting bug, which the caller turns into a panic.
pub fn earned(stake: u128, delta: u128) -> Option<u128> {
    if stake == 0 || delta == 0 {
        return Some(0);
    }
    (delta / ACC_SCALE)
        .checked_mul(stake)?
        .checked_add((delta % ACC_SCALE) * stake / ACC_SCALE)
}

/// `(tax, net)` for an unstaked amount: tax rounded down, `tax + net == amount` exactly.
pub fn exit_tax(amount: u128) -> (u128, u128) {
    let tax = bps_of(amount, EXIT_TAX_BPS);
    (tax, amount - tax)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: u128 = 1_000_000_000_000_000_000;

    #[test]
    fn whole_day_is_exactly_a_tenth() {
        assert_eq!(drip(1_000 * TOKEN, DAY_NS), 100 * TOKEN);
        assert_eq!(drip(1_000 * TOKEN, 2 * DAY_NS), 190 * TOKEN);
        assert_eq!(drip(9, DAY_NS), 0);
        assert_eq!(drip(0, 30 * DAY_NS), 0);
    }

    #[test]
    fn partial_day_is_linear_within_the_day() {
        assert_eq!(drip(1_000 * TOKEN, DAY_NS / 2), 50 * TOKEN);
        assert_eq!(drip(1_000 * TOKEN, DAY_NS / 4), 25 * TOKEN);
        // 1.5 days: 100, then 900 × 0.5 / 10 = 45.
        assert_eq!(drip(1_000 * TOKEN, DAY_NS + DAY_NS / 2), 145 * TOKEN);
    }

    #[test]
    fn drip_never_exceeds_the_pool_even_at_the_bound() {
        for elapsed in [1, DAY_NS - 1, DAY_NS, 400 * DAY_NS, u64::MAX] {
            for pool in [1, 7, MPOO_BOUND, u128::MAX / DAY_NS as u128] {
                assert!(drip(pool, elapsed) <= pool);
            }
        }
        assert!(drip(MPOO_BOUND, 365 * DAY_NS) < MPOO_BOUND);
    }

    #[test]
    fn split_charges_no_more_than_the_release_and_no_less_than_claims() {
        for (release, total) in [
            (1, 3),
            (10, 3),
            (TOKEN, 7),
            (MPOO_BOUND, 1),
            (MPOO_BOUND, TOILET_CAP),
            (5, TOILET_CAP),
        ] {
            let (inc, charged) = split_release(release, total);
            assert!(charged <= release);
            // The stakers' claims (one per unit of stake at most) fit inside `charged`.
            assert!(earned(total, inc).unwrap() <= charged);
        }
    }

    #[test]
    fn exit_tax_is_exact() {
        assert_eq!(exit_tax(100), (10, 90));
        assert_eq!(exit_tax(19), (1, 18));
        assert_eq!(exit_tax(9), (0, 9));
        assert_eq!(
            exit_tax(TOILET_CAP),
            (TOILET_CAP / 10, TOILET_CAP - TOILET_CAP / 10)
        );
        assert_eq!(exit_tax(u128::MAX).0 + exit_tax(u128::MAX).1, u128::MAX);
    }
}
