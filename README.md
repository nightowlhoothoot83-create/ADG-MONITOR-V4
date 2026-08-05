# ADG Monitor v4

Cloudflare Worker source for the Ascension Digital Group AdSense-site monitor.

## Safety model

- Daily audits are read-only.
- Repairs never edit production directly.
- Repairs create a dated GitHub branch and pull request.
- A human reviews and merges each repair.
- Cloudflare Pages performs the production deployment after merge.
- The repair endpoint requires the encrypted `REPAIR_APPROVAL_KEY` secret.

## Managed sites

- `mycalctools.net` Ã¢â€ â€™ `nightowlhoothoot83-create/Mycalctools`
- `mycalendartools.net` Ã¢â€ â€™ `nightowlhoothoot83-create/Mycalendartools`
- `wheelnamepicker.com.au` Ã¢â€ â€™ `nightowlhoothoot83-create/Wheelnamepicker`

## SaaS monitor

AdSense sites and Raven-Sharp SaaS products run as separate monitor invocations. Indexing rotates through one AdSense site per invocation, preventing Search Console, sitemap, redirect and live-page checks from exhausting Cloudflare's subrequest allowance.

- `pod.raven-sharp.com` - Raven-Sharp POD
- `opt.raven-sharp.com` - Image Optimiser & Upscaler
- `cleaner.raven-sharp.com` - Smart AI Cleaner (awaiting deployment)
- `ads.raven-sharp.com` - Ad Manager (awaiting deployment)
- `books.raven-sharp.com` - Book Creator (awaiting deployment)
- `content.raven-sharp.com` - Content Creator (awaiting deployment)

Endpoints: `/adsense/run` runs the three AdSense homepage checks, `/saas/run-view` runs the six SaaS checks, and `/indexing/run?site=<id>` runs indexing for one AdSense site. `/indexing/run` rotates to the next site automatically.

## Page discovery and Google indexing

- The Worker reads each managed site's robots.txt and sitemap files.
- It stores up to 100 discovered URLs per site in the latest indexing report.
- A separate daily trigger rotates through URL Inspection checks without exhausting the health-monitor request budget.
- Sitemaps are submitted through the Search Console API.
- The dashboard provides manual **Check indexing** and **Check repairs** actions.

## Repair policy

- Missing sitemap references and missing self-canonicals are safe automatic corrections.
- Redirect-like links, policy-link changes, canonical conflicts, and other consequential changes are placed in the dashboard approval queue.
- Approved changes use the protected repair endpoint to create a reviewable GitHub pull request.

### Approving queued repairs

1. Open `/repair/scan` and review every proposed change.
2. Select **Approve queued repairs**.
3. Enter the value configured as the Worker's `REPAIR_APPROVAL_KEY` secret.
4. The key is sent only in the `Authorization` header to `POST /repair/run`; it is not stored by the dashboard.
5. Review and merge the resulting GitHub pull requests before Cloudflare Pages deploys them.

If the secret value is no longer known, replace `REPAIR_APPROVAL_KEY` in the Worker's Cloudflare settings and use the new value. Cloudflare does not reveal an existing secret value.

## Required Cloudflare bindings

- `MONITOR_KV`: existing `site-monitor-history` KV namespace
- `GITHUB_TOKEN`: fine-grained or classic token with repository contents and pull-request write access
- `REPAIR_APPROVAL_KEY`: separate random secret required to approve repair pull requests
- `GSC_SERVICE_ACCOUNT_KEY`: Google service-account JSON with Search Console access

Google's general Search Console API supports sitemap submission and URL inspection. Direct Indexing API notifications are intentionally excluded because Google restricts them to qualifying job-posting and livestream pages.


