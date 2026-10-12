//! Pure regional pressure pricing math.
//!
//! Adapted from `simulations/pressure/rust` for the paid board contract.
//! Keep this module in sync with the simulation golden vectors; do not
//! change the sim package from here.

/// Prototype fixture config from pressure-and-paint.md (not production economics).
#[derive(Clone, Debug)]
pub struct PressureConfig {
    pub version: u32,
    pub base_cost: u128,
    pub max_cost: u128,
    pub heat_cap: u128,
    pub heat_increment: u128,
    pub decay_per_second: u128,
    pub surcharge_numerator: u128,
    pub surcharge_denominator: u128,
    pub effective_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegionState {
    pub heat: u128,
    pub updated_at_seconds: u64,
}

#[derive(Clone, Debug)]
pub struct BoardGeometry {
    pub width: u32,
    pub height: u32,
    pub region_size: u32,
}

pub const FIXTURE_CONFIG: PressureConfig = PressureConfig {
    version: 1,
    base_cost: 10,
    max_cost: 50,
    heat_cap: 400,
    heat_increment: 10,
    decay_per_second: 1,
    surcharge_numerator: 1,
    surcharge_denominator: 10,
    effective_at: 0,
};

pub const FIXTURE_GEOMETRY: BoardGeometry = BoardGeometry {
    width: 128,
    height: 128,
    region_size: 8,
};

/// Advisory quote TTL: 30 seconds in nanoseconds.
pub const FIXTURE_QUOTE_TTL_NS: u64 = 30_000_000_000;
/// Reject client expiries farther than this into the execution-time future.
pub const MAX_QUOTE_FUTURE_NS: u64 = 30_000_000_000;

#[derive(Debug, PartialEq, Eq)]
pub enum PressureError {
    ZeroDenominator,
    OutOfBounds,
    /// cooled_heat × surcharge_numerator (or related) exceeds u128.
    Overflow,
}

pub fn region_columns(geometry: &BoardGeometry) -> u32 {
    geometry.width.div_ceil(geometry.region_size)
}

pub fn region_count(geometry: &BoardGeometry) -> u32 {
    let cols = region_columns(geometry);
    let rows = geometry.height.div_ceil(geometry.region_size);
    cols.saturating_mul(rows)
}

pub fn region_id(geometry: &BoardGeometry, x: u32, y: u32) -> Result<u32, PressureError> {
    if x >= geometry.width || y >= geometry.height {
        return Err(PressureError::OutOfBounds);
    }
    let cols = region_columns(geometry);
    let size = geometry.region_size;
    Ok((y / size) * cols + (x / size))
}

fn assert_valid(config: &PressureConfig) -> Result<(), PressureError> {
    if config.surcharge_denominator == 0 {
        return Err(PressureError::ZeroDenominator);
    }
    Ok(())
}

/// Bound elapsed so `decay * elapsed` cannot overflow and cooling saturates at 0.
pub fn bound_elapsed_for_decay(heat: u128, decay_per_second: u128, elapsed: u64) -> u64 {
    if elapsed == 0 || heat == 0 || decay_per_second == 0 {
        return 0;
    }
    let rem = heat % decay_per_second;
    let max_useful = heat / decay_per_second + if rem == 0 { 0 } else { 1 };
    let max_useful_u64 = u64::try_from(max_useful).unwrap_or(u64::MAX);
    elapsed.min(max_useful_u64)
}

pub fn cooled_heat_at(
    region: &RegionState,
    config: &PressureConfig,
    t: u64,
) -> Result<(u64, u128), PressureError> {
    assert_valid(config)?;
    let elapsed = t.saturating_sub(region.updated_at_seconds);
    let bounded = bound_elapsed_for_decay(region.heat, config.decay_per_second, elapsed);
    let decayed = config
        .decay_per_second
        .saturating_mul(u128::from(bounded));
    let cooled = region.heat.saturating_sub(decayed);
    Ok((elapsed, cooled))
}

pub fn placement_cost(cooled_heat: u128, config: &PressureConfig) -> Result<u128, PressureError> {
    assert_valid(config)?;
    // checked_mul (not saturating_mul) so Rust and TypeScript reject the same
    // overflow boundary instead of disagreeing on surcharge.
    let product = cooled_heat
        .checked_mul(config.surcharge_numerator)
        .ok_or(PressureError::Overflow)?;
    let surcharge = product / config.surcharge_denominator;
    let uncapped = config
        .base_cost
        .checked_add(surcharge)
        .ok_or(PressureError::Overflow)?;
    Ok(uncapped.min(config.max_cost))
}

pub fn quote_region(
    region: &RegionState,
    config: &PressureConfig,
    t: u64,
) -> Result<(u64, u128, u128), PressureError> {
    let (elapsed, cooled) = cooled_heat_at(region, config, t)?;
    let cost = placement_cost(cooled, config)?;
    Ok((elapsed, cooled, cost))
}

pub fn apply_successful_heat(
    cooled_heat: u128,
    config: &PressureConfig,
    t: u64,
) -> Result<RegionState, PressureError> {
    assert_valid(config)?;
    let raised = cooled_heat.saturating_add(config.heat_increment);
    Ok(RegionState {
        heat: raised.min(config.heat_cap),
        updated_at_seconds: t,
    })
}

pub fn cold_region() -> RegionState {
    RegionState {
        heat: 0,
        updated_at_seconds: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct DocumentedExamplesFile {
        cases: Vec<DocumentedCase>,
    }

    #[derive(Deserialize)]
    struct DocumentedCase {
        id: String,
        region: RegionJson,
        t: String,
        expect: ExpectJson,
    }

    #[derive(Deserialize)]
    struct RegionJson {
        heat: String,
        updated_at_seconds: String,
    }

    #[derive(Deserialize)]
    struct ExpectJson {
        elapsed: String,
        cooled_heat: String,
        cost: String,
        #[serde(default)]
        heat_after_success: Option<String>,
    }

    #[derive(Deserialize)]
    struct OverflowFile {
        cases: Vec<OverflowCase>,
    }

    #[derive(Deserialize)]
    struct OverflowCase {
        id: String,
        cooled_heat: String,
        config: OverflowConfigJson,
        expect: OverflowExpect,
    }

    #[derive(Deserialize)]
    struct OverflowConfigJson {
        base_cost: String,
        max_cost: String,
        heat_cap: String,
        heat_increment: String,
        decay_per_second: String,
        surcharge_numerator: String,
        surcharge_denominator: String,
        effective_at: String,
        version: u32,
    }

    #[derive(Deserialize)]
    struct OverflowExpect {
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        cost: Option<String>,
    }

    fn parse_u128(s: &str) -> u128 {
        s.parse::<u128>()
            .unwrap_or_else(|_| panic!("invalid u128 decimal string: {s}"))
    }

    fn parse_u64(s: &str) -> u64 {
        s.parse::<u64>()
            .unwrap_or_else(|_| panic!("invalid u64 decimal string: {s}"))
    }

    #[test]
    fn fixture_region_count_is_256() {
        assert_eq!(region_count(&FIXTURE_GEOMETRY), 256);
    }

    #[test]
    fn documented_examples_match_golden_json() {
        let raw = include_str!("../../../simulations/pressure/fixtures/golden/documented-examples.json");
        let file: DocumentedExamplesFile =
            serde_json::from_str(raw).expect("parse documented-examples");

        for case in file.cases {
            let region = RegionState {
                heat: parse_u128(&case.region.heat),
                updated_at_seconds: parse_u64(&case.region.updated_at_seconds),
            };
            let t = parse_u64(&case.t);
            let (elapsed, cooled) =
                cooled_heat_at(&region, &FIXTURE_CONFIG, t).expect("cool");
            let cost = placement_cost(cooled, &FIXTURE_CONFIG).expect("cost");
            assert_eq!(elapsed, parse_u64(&case.expect.elapsed), "{}", case.id);
            assert_eq!(cooled, parse_u128(&case.expect.cooled_heat), "{}", case.id);
            assert_eq!(cost, parse_u128(&case.expect.cost), "{}", case.id);
            if let Some(after) = &case.expect.heat_after_success {
                let next = apply_successful_heat(cooled, &FIXTURE_CONFIG, t).unwrap();
                assert_eq!(next.heat, parse_u128(after), "{}", case.id);
            }
        }
    }

    #[test]
    fn overflow_boundary_matches_golden_json() {
        let raw = include_str!("../../../simulations/pressure/fixtures/golden/overflow-boundary.json");
        let file: OverflowFile = serde_json::from_str(raw).expect("parse overflow");
        for case in file.cases {
            let cfg = PressureConfig {
                version: case.config.version,
                base_cost: parse_u128(&case.config.base_cost),
                max_cost: parse_u128(&case.config.max_cost),
                heat_cap: parse_u128(&case.config.heat_cap),
                heat_increment: parse_u128(&case.config.heat_increment),
                decay_per_second: parse_u128(&case.config.decay_per_second),
                surcharge_numerator: parse_u128(&case.config.surcharge_numerator),
                surcharge_denominator: parse_u128(&case.config.surcharge_denominator),
                effective_at: parse_u64(&case.config.effective_at),
            };
            let cooled = parse_u128(&case.cooled_heat);
            match case.expect.error.as_deref() {
                Some("overflow") => {
                    let err = placement_cost(cooled, &cfg).unwrap_err();
                    assert!(matches!(err, PressureError::Overflow), "{}", case.id);
                }
                _ => {
                    let cost = placement_cost(cooled, &cfg).expect(&case.id);
                    let expected = parse_u128(case.expect.cost.as_ref().unwrap());
                    assert_eq!(cost, expected, "{}", case.id);
                }
            }
        }
    }
}
