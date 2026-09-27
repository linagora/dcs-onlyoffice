// The page shows a validity period as whole days, UTC: from the first to
// the last. A day left as it was keeps the instant the directory holds, so
// that saving other terms moves nothing.
export function firstDayOf(validFrom: string): string {
  return validFrom.slice(0, 10);
}

export function lastDayOf(validUntil: string): string {
  const end = Date.parse(validUntil);
  return Number.isNaN(end) ? '' : new Date(end - 1).toISOString().slice(0, 10);
}

export function firstInstant(day: string | null, was: string | null): string {
  if (was !== null && day === firstDayOf(was)) {
    return was;
  }
  return isDay(day) ? `${day}T00:00:00.000Z` : '';
}

// A period ends at the first instant after its last day.
export function instantAfter(day: string | null, was: string | null): string {
  if (was !== null && day === lastDayOf(was)) {
    return was;
  }
  return isDay(day) ? new Date(Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000).toISOString() : '';
}

function isDay(day: string | null): day is string {
  return day !== null && /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00.000Z`));
}
