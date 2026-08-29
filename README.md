# ADG Monitor V4

Final AdSense monitor branch: `codex/full-regression-baselines`

This branch protects the three current AdSense sites only: MyCalcTools, MyCalendarTools and WheelNamePicker.

Final gate coverage now includes:
- explicit approval-only baseline saves
- full recent sitemap coverage before a baseline can be approved
- page fingerprints for HTML, headings, footer, images, internal links, form controls, canonicals and word count
- image-delivery fingerprints for lazy-loading, explicit intrinsic sizing and high-priority image usage
- shared CSS, JavaScript and consent-asset fingerprints
- exact critical-route probes for the routes that were reported broken during final readiness testing:
  - MyCalcTools: `/bmi-calculator`, `/calorie-calculator`
  - MyCalendarTools: `/privacy/`, `/days-until-christmas/`, `/days-between/`
  - WheelNamePicker: `/coin-toss`, `/dice-roller`, `/lucky-dip`
- failure when a critical clean route redirects elsewhere, returns a bad status or stops serving HTML
- sitemap additions/removals and page/asset signature changes
- existing header/footer, canonical, robots, sitemap, consent, ads.txt and indexability checks
- two-consecutive-failure confirmation and recovery clearing
- no automatic baseline replacement and no automatic production deployment

The final gate update was applied only after `npm test` and `npm run check:all` passed. Optimized image replacements are intended to become the new protected baseline only after the corrected sites have been visually and functionally approved.
