/**
 * Timezone helpers for converting a calendar date in a specific IANA timezone
 * to UTC start/end timestamps.
 *
 * No external dependencies – uses Intl.DateTimeFormat.
 */

/**
 * Get the timezone offset in minutes for a given instant and IANA timezone.
 * Returns offset = local - UTC in minutes.
 * e.g. America/New_York in EST is -300, in EDT is -240.
 */
export function getTimezoneOffsetMinutes(instant: Date, timeZone: string): number {
	try {
		const dtf = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		});

		const parts = dtf.formatToParts(instant);
		const map: Record<string, string> = {};
		for (const p of parts) {
			if (p.type !== "literal") map[p.type] = p.value;
		}

		// Interpret the tz wall time as if it were UTC
		const year = map.year ?? "1970";
		const month = map.month ?? "01";
		const day = map.day ?? "01";
		const hour = map.hour ?? "00";
		const minute = map.minute ?? "00";
		const second = map.second ?? "00";
		const tzAsUTC = Date.UTC(
			parseInt(year, 10),
			parseInt(month, 10) - 1,
			parseInt(day, 10),
			parseInt(hour, 10),
			parseInt(minute, 10),
			parseInt(second, 10),
		);

		// Difference: local-as-UTC minus actual instant
		return (tzAsUTC - instant.getTime()) / 60000;
	} catch {
		// Invalid timezone -> fallback to 0 (UTC)
		return 0;
	}
}

/**
 * Convert a wall time in a timezone to a UTC Date.
 * year, month (1-12), day, hour, minute, second are the local components.
 */
export function zonedTimeToUtc(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
	timeZone: string,
): Date {
	// First guess: treat wall time as UTC
	let utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));

	// Iterate to converge offset – 2 iterations enough for any DST gap (max 1 adjust)
	for (let i = 0; i < 3; i++) {
		const offset = getTimezoneOffsetMinutes(utcGuess, timeZone);
		const next = new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0) - offset * 60 * 1000);
		if (next.getTime() === utcGuess.getTime()) break;
		utcGuess = next;
	}

	return utcGuess;
}

export interface DayRangeUtc {
	takenAfter: string; // ISO
	takenBefore: string; // ISO
	startUtc: Date;
	endUtc: Date;
}

/**
 * Parse a date string (YYYY-MM-DD or ISO) into year/month/day components.
 * Returns null if unparsable.
 */
export function parseDateOnly(dateStr: string): { year: number; month: number; day: number } | null {
	if (!dateStr) return null;
	const trimmed = dateStr.trim();

	// Try YYYY-MM-DD prefix extraction (also handles ISO like 2023-01-15T...)
	const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (match) {
		const y = parseInt(match[1] ?? "", 10);
		const m = parseInt(match[2] ?? "", 10);
		const d = parseInt(match[3] ?? "", 10);
		if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
			return { year: y, month: m, day: d };
		}
	}

	// Fallback: try Date parsing and extract UTC parts if it's a full date
	const d = new Date(trimmed);
	if (!isNaN(d.getTime())) {
		return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
	}

	return null;
}

/**
 * Given a calendar date string and IANA timezone, compute UTC range for that whole day.
 * If timeZone is empty, UTC is assumed.
 */
export function getDayRangeUtc(dateStr: string, timeZone: string): DayRangeUtc | null {
	const parsed = parseDateOnly(dateStr);
	if (!parsed) return null;

	const tz = timeZone && timeZone.trim() ? timeZone.trim() : "UTC";

	const startUtc = zonedTimeToUtc(parsed.year, parsed.month, parsed.day, 0, 0, 0, tz);
	const endUtc = zonedTimeToUtc(parsed.year, parsed.month, parsed.day + 1, 0, 0, 0, tz);

	// Handle month overflow (day+1 may exceed month length). zonedTimeToUtc using Date.UTC handles overflow automatically
	// because Date.UTC handles day overflow, but we passed day+1 as day component, which works because Date.UTC normalizes.
	// To be safe, if day+1 > 31, the Date.UTC overflow already normalized.

	return {
		startUtc,
		endUtc,
		takenAfter: startUtc.toISOString(),
		takenBefore: endUtc.toISOString(),
	};
}

/**
 * Normalize timezone string, empty -> UTC.
 */
export function normalizeTimeZone(tz: string | undefined | null): string {
	if (!tz) return "UTC";
	const trimmed = String(tz).trim();
	if (!trimmed) return "UTC";
	try {
		// Validate via Intl
		new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
		return trimmed;
	} catch {
		return "UTC";
	}
}
