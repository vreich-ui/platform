/**
 * Site island entry (W11 T11.5): registers this site's policy/identity
 * providers, then re-exports the core admin component. Core admin code never
 * imports site config — this wrapper is the client-bundle seam that makes
 * getSiteIdentity()/active*Policy() resolve inside the island.
 */
import '@site/config/policy-bindings';

import { createElement } from 'react';

import CoreGovernancePage, { type GovernancePageProps } from '@core/admin/GovernancePage';
import { parseTrackingExport } from '@core/lib/tracking/assemble';

const trackingExports = import.meta.glob('@site/data/site/tracking.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

const loadAnalyticsIdMode = (): GovernancePageProps['analyticsIdMode'] => {
  const [exported] = Object.values(trackingExports);
  if (!exported) return 'granted-only';
  const body = { ...(exported as Record<string, unknown>) };
  delete body.__generated;
  return parseTrackingExport(body).consent.analytics_id_mode;
};

const analyticsIdMode = loadAnalyticsIdMode();

export default function GovernancePage(props: Omit<GovernancePageProps, 'analyticsIdMode'>) {
  return createElement(CoreGovernancePage, { ...props, analyticsIdMode });
}
