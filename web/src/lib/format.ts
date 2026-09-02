// Formatage francais. Intl est natif : aucune bibliotheque de dates.

const NUMBER = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
const DAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const DAY_LONG = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const TIME = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** Charge : « 82,5 », « 80 ». Jamais de zero decimal inutile. */
export const kg = (value: number): string => NUMBER.format(value);

export const signed = (value: number, digits = 1): string =>
  `${value >= 0 ? '+' : '−'}${NUMBER.format(Math.abs(Number(value.toFixed(digits))))}`;

export const dayLabel = (iso: string): string => DAY.format(new Date(iso));
export const dayLabelLong = (iso: string): string => DAY_LONG.format(new Date(iso));
export const timeLabel = (iso: string): string => TIME.format(new Date(iso));

/** « aujourd'hui », « hier », « il y a 5 j », « il y a 3 sem ». */
export function ago(iso: string): string {
  const then = new Date(iso);
  const days = Math.floor((startOfDay(new Date()) - startOfDay(then)) / 86_400_000);

  if (days <= 0) return "aujourd'hui";
  if (days === 1) return 'hier';
  if (days < 14) return `il y a ${days} j`;
  if (days < 60) return `il y a ${Math.round(days / 7)} sem`;
  return `il y a ${Math.round(days / 30)} mois`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Minuteur : « 2:00 », « 0:07 ». */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Duree d'une seance : « 1 h 12 », « 47 min ». */
export function duration(startIso: string, endIso: string): string {
  const minutes = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

/** « 4 × 6-8 » ou « 3 × 12 » selon que la fourchette est ouverte. */
export const scheme = (sets: number, repMin: number, repMax: number): string =>
  `${sets} × ${repMin === repMax ? repMin : `${repMin}-${repMax}`}`;
