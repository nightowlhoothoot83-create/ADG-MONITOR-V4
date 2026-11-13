# Monitor status correction — 13 November 2026 UTC

The live report showed all three sites as clean despite `baseline_manifest_pages: 0`. The dashboard rendered every status other than confirmed/pending regression as Protected. This could also label an absent baseline as protected and hide an overdue per-site scan behind another site's newer report time.

This repair requires a complete page and shared-asset baseline before a scan can be clean, records whether current coverage is complete, requires publisher identity when approving a new baseline, and rejects inconsistent or duplicate page inventories. The dashboard displays each site's check timestamp, labels missing/incomplete protection explicitly, and treats scans older than 36 hours as overdue. The threshold is an interim daily-monitor warning, not real-time monitoring.

Validation: Node unit/integration tests exercise legacy baseline records, missing publisher identity, duplicate page inventories, deliberately removed pages/content/styles, incomplete coverage, stale timestamps, dashboard output, and recovery after repeated failures. All existing monitor syntax checks are required as well.

Scope: monitor source and tests only. No files, CSS, colours, calculator logic, content or routes in Mycalctools, Mycalendartools or Wheelnamepicker are changed. Baselines are not reset. Review-freeze, production schedules, automatic merge controls and deployments are not altered. A branch commit is not a deployed repair.

Still outstanding: restore complete scans within Worker request limits; establish approved complete baselines from verified site versions; provide all-day checks and independent heartbeat alerts; integrate browser tests and independent known-answer cases for individual tools; build reviewed content-update proposals. Automated writing quality and factual correctness cannot be inferred from an HTML fingerprint.
