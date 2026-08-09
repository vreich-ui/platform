/**
 * Tenant-safe labels used by the shared admin shell. The shell is fleet law,
 * so a client name must always come from the bound SiteIdentity rather than a
 * label left over from another publication.
 */
export const settingsNavigationLabel = (brandName: string | undefined): string => {
  const label = brandName?.trim();
  return label ? `Settings · ${label}` : 'Settings';
};
