//! Award split allocation: floor(award * bps / 10000); dust to last sorted recipient.
//! Mirrors `shared/protocol/bounties.ts` `allocateAwardAmounts`.

use near_sdk::AccountId;

pub const SHARE_BPS_TOTAL: u16 = 10_000;
pub const MAX_RECIPIENTS: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecipientShare {
    pub account_id: AccountId,
    pub share_bps: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AllocatedShare {
    pub account_id: AccountId,
    pub amount: u128,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SplitError {
    NoRecipients,
    TooManyRecipients,
    ShareSumNot10000,
    DuplicateRecipients,
    NonPositiveShare,
    ZeroAllocation,
}

impl SplitError {
    pub fn code(&self) -> &'static str {
        match self {
            SplitError::NoRecipients
            | SplitError::TooManyRecipients
            | SplitError::ShareSumNot10000
            | SplitError::DuplicateRecipients
            | SplitError::NonPositiveShare
            | SplitError::ZeroAllocation => "SPLIT_INVALID",
        }
    }

    pub fn message(&self) -> &'static str {
        match self {
            SplitError::NoRecipients => "no recipients",
            SplitError::TooManyRecipients => "too many recipients",
            SplitError::ShareSumNot10000 => "share_bps must sum to 10000",
            SplitError::DuplicateRecipients => "duplicate recipients",
            SplitError::NonPositiveShare => "non-positive share",
            SplitError::ZeroAllocation => "zero allocation",
        }
    }
}

/// Sort by account id ascending, validate, allocate with dust to the last sorted recipient.
pub fn allocate_award_amounts(
    award_amount: u128,
    recipients: &[RecipientShare],
) -> Result<Vec<AllocatedShare>, SplitError> {
    if recipients.is_empty() {
        return Err(SplitError::NoRecipients);
    }
    if recipients.len() > MAX_RECIPIENTS {
        return Err(SplitError::TooManyRecipients);
    }

    let mut sorted = recipients.to_vec();
    sorted.sort_by(|a, b| a.account_id.as_str().cmp(b.account_id.as_str()));

    let share_sum: u32 = sorted.iter().map(|r| u32::from(r.share_bps)).sum();
    if share_sum != u32::from(SHARE_BPS_TOTAL) {
        return Err(SplitError::ShareSumNot10000);
    }

    for i in 1..sorted.len() {
        if sorted[i].account_id == sorted[i - 1].account_id {
            return Err(SplitError::DuplicateRecipients);
        }
    }

    let mut allocated = Vec::with_capacity(sorted.len());
    let mut remaining = award_amount;
    let last = sorted.len() - 1;

    for (i, recipient) in sorted.iter().enumerate() {
        if recipient.share_bps == 0 {
            return Err(SplitError::NonPositiveShare);
        }
        if i == last {
            if remaining == 0 {
                return Err(SplitError::ZeroAllocation);
            }
            allocated.push(AllocatedShare {
                account_id: recipient.account_id.clone(),
                amount: remaining,
            });
            break;
        }
        let amount = award_amount
            .checked_mul(u128::from(recipient.share_bps))
            .and_then(|v| v.checked_div(u128::from(SHARE_BPS_TOTAL)))
            .ok_or(SplitError::ZeroAllocation)?;
        if amount == 0 {
            return Err(SplitError::ZeroAllocation);
        }
        allocated.push(AllocatedShare {
            account_id: recipient.account_id.clone(),
            amount,
        });
        remaining = remaining.saturating_sub(amount);
    }

    Ok(allocated)
}

/// Stable sorted copy used for digests and storage.
pub fn sort_recipients(recipients: &[RecipientShare]) -> Vec<RecipientShare> {
    let mut sorted = recipients.to_vec();
    sorted.sort_by(|a, b| a.account_id.as_str().cmp(b.account_id.as_str()));
    sorted
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::AccountId;

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    #[test]
    fn fixture_split_dust_to_last_sorted() {
        // Mirrors shared/fixtures/bounties/split-allocation.json
        let recipients = vec![
            RecipientShare {
                account_id: acct("carol.testnet"),
                share_bps: 3333,
            },
            RecipientShare {
                account_id: acct("alice.testnet"),
                share_bps: 3334,
            },
            RecipientShare {
                account_id: acct("bob.testnet"),
                share_bps: 3333,
            },
        ];
        let allocated = allocate_award_amounts(10, &recipients).unwrap();
        assert_eq!(allocated.len(), 3);
        assert_eq!(allocated[0].account_id.as_str(), "alice.testnet");
        assert_eq!(allocated[0].amount, 3);
        assert_eq!(allocated[1].account_id.as_str(), "bob.testnet");
        assert_eq!(allocated[1].amount, 3);
        assert_eq!(allocated[2].account_id.as_str(), "carol.testnet");
        assert_eq!(allocated[2].amount, 4);
    }

    #[test]
    fn rejects_bad_sum_and_duplicates() {
        assert_eq!(
            allocate_award_amounts(
                100,
                &[RecipientShare {
                    account_id: acct("alice.testnet"),
                    share_bps: 9999,
                }]
            ),
            Err(SplitError::ShareSumNot10000)
        );
        assert_eq!(
            allocate_award_amounts(
                100,
                &[
                    RecipientShare {
                        account_id: acct("alice.testnet"),
                        share_bps: 5000,
                    },
                    RecipientShare {
                        account_id: acct("alice.testnet"),
                        share_bps: 5000,
                    },
                ]
            ),
            Err(SplitError::DuplicateRecipients)
        );
    }
}
