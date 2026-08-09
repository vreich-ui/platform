/** Keep object-map counts explicit: media artifacts are not governed objects. */
export const governedMediaCountLabel = (count: number): string =>
  `${count} governed media object${count === 1 ? '' : 's'} · assets in Media`;
