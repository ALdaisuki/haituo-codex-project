# B0D4V7M7D4 Price Source Fix Report

## Summary

Date: 2026-07-07

Branch: `codex/b0d4v7m7d4-price-source-fix`

Target ASIN: `B0D4V7M7D4`

Scope: repository data correction only. No Dianxiaomi browser page was opened or operated in this step.

## Root Cause

The readonly edit-page preflight report showed a price-source mismatch:

- Prior controlled collection report recorded Amazon displayed price USD `9.99`.
- Current task formula is `9.99 x 7 x 1.55 = 108.39`.
- The readonly preflight used fallback source price USD `5.89`, expected CNY `63.91`.
- The price store status for `B0D4V7M7D4` was `amazon_displayed_price_missing`.

Local category evidence was not the missing part. `runs/aliexpress-evidence-store.json` already contains high-confidence evidence for this ASIN:

- status: `aliexpress_verified`
- confidence tier: `high_confidence`
- AliExpress category: `postCategoryId:100001805`
- DXM candidate category: `Pot Trays`

## Fix Applied

Added one trusted Amazon displayed-price record to `runs/amazon-price-store.json`:

```text
ASIN: B0D4V7M7D4
amazonDisplayedPriceUsd: 9.99
currency: USD
source: manual_verified
status: trusted
amazonUrl: https://www.amazon.com/dp/B0D4V7M7D4
reason: price_source_corrected_from_controlled_collection_report
```

This does not encode the task formula into the price store. The expected CNY value is still computed at runtime from task parameters.

## Verification

RED check before the fix:

```text
node tools\amazon-price-store.js status --asins B0D4V7M7D4 --exchange-rate 7 --multiplier 1.55
status: missing
trusted: false
reason: amazon_displayed_price_missing
blockers: 1
```

GREEN checks after the fix:

```text
node tools\amazon-price-store.js status --asins B0D4V7M7D4 --exchange-rate 7 --multiplier 1.55
status: trusted
trusted: true
amazonDisplayedPriceUsd: 9.99
expectedCnyPrice: 108.39
formulaOk: true
blockers: 0
```

```text
node tools\amazon-price-store.js compute --asin B0D4V7M7D4 --exchange-rate 7 --multiplier 1.55
expectedCnyPrice: 108.39
formula: amazonDisplayedPriceUsd * exchangeRate * multiplier
```

Regression checks:

```text
node tools\dxm-automation-core.test.js
node tools\aliexpress-evidence-policy.test.js
```

Both passed.

## Safety Boundary

- No Dianxiaomi field edit was executed.
- No save or move-to-wait-publish was executed.
- No publish, one-click publish, or collection-and-one-click-publish was executed.
- No new collection or new claim was executed.
- No userscript logic, `AGENT.md`, `TASK.md`, or rule document was changed.
- Browser `localStorage` was not synced in this step.

## Next Safe Step

Sync the updated `runs/amazon-price-store.json` record to the browser price cache, then rerun readonly edit-page preflight for `B0D4V7M7D4`.

Only after readonly preflight confirms the price source is `9.99 -> 108.39` should the controlled edit-page fill continue with `save:false`. Save-to-wait-publish still requires explicit user confirmation after all preflight blockers are cleared.
