# AdSense / Site Monitor Manager Hub Integration

Branch-only integration contract. No production worker deploy, index request, site mutation, ad change, merge, or publish action is authorised by this file.

## Sites in scope

- MyCalcTools.net
- MyCalendarTools.net
- WheelNamePicker.com.au
- Additional approved AdSense/utility properties discovered by inventory

## Manager Hub status model

For each property, surface independently where data exists:

- site reachability;
- AdSense readiness / approval state;
- ads.txt health;
- indexing / SEO findings;
- broken links;
- mobile/performance findings;
- visual regression findings;
- current repository mapping;
- current deployment mapping;
- latest monitor run;
- next monitor run;
- outstanding repair requests;
- minor visual issues;
- evidence/history.

Do not collapse all of these into a single green/red site status.

## Repair request flow

**Monitor → finding → repair request → proposed fix → test evidence → review → approval where needed → retest → resolved**

Allow `Dismiss` and `Already fixed` while preserving history.

## Controls

Safe/contextual actions can include:

- Run / Rerun monitor
- Retest
- Review evidence
- Create repair
- Dismiss
- Already fixed
- Pause / Resume monitor where configured
- Schedule where the monitor supports scheduling
- Open site / repo / preview

Any action that changes production, requests external indexing, publishes, merges, deploys, or mutates ad configuration must remain separately gated according to the Manager Hub risk policy.

## Minor visual issues

The monitor should be able to surface low-severity issues such as card colours/glows, old logos, inconsistent buttons, spacing, typography, duplicate elements, mobile layout quirks, or broken symbols without treating them as launch-blocking failures.

## Acceptance criteria

- AdSense/utility sites appear as first-class Manager Hub properties alongside SaaS.
- Existing monitor output is reused rather than duplicated.
- Findings can create/update Hub repair requests.
- Site and AdSense statuses remain distinguishable.
- A clean site monitor does not imply AdSense approval, and AdSense approval does not imply the site has no visual/functional defects.
