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

- `mycalctools.net` â†’ `nightowlhoothoot83-create/Mycalctools`
- `mycalendartools.net` â†’ `nightowlhoothoot83-create/Mycalendartools`
- `wheelnamepicker.com.au` â†’ `nightowlhoothoot83-create/Wheelnamepicker`

## Required Cloudflare bindings

- `MONITOR_KV`: existing `site-monitor-history` KV namespace
- `GITHUB_TOKEN`: fine-grained or classic token with repository contents and pull-request write access
- `REPAIR_APPROVAL_KEY`: separate random secret required to run repairs

Google's general Search Console API supports sitemap submission and URL inspection. Direct Indexing API notifications are intentionally excluded because Google restricts them to qualifying job-posting and livestream pages.

