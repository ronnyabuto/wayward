// Smallest drive-time saving worth waiting for. Google's predictive durations
// move by a minute or two between adjacent probes on a steady road, so a
// smaller gap is forecast noise rather than a real improvement. Same 3-min
// line check.js and depart.js already use for "notably faster/slower".
export const MIN_WORTHWHILE_SAVING_MIN = 3;

// Decides what to tell a user who is ready to leave now and whose drive is
// over the acceptable threshold. forecast is [{ offset, minutes }] from the
// predictive probes, in offset order.
//
// The threshold comes from a baseline that can be the no-traffic time, which
// on many Nairobi routes is never reached during the day — so "wait until it
// drops under the threshold" is only one of the answers. The forecast itself
// decides whether waiting helps at all:
//   clears   — the forecast reaches the threshold; wait until then.
//   improves — never reaches it, but waiting saves real time; wait for the best point.
//   flat     — waiting doesn't meaningfully beat leaving now.
//   unknown  — no forecast came back.
export function planDeparture(currentMin, threshold, forecast) {
  if (forecast.length === 0) return { kind: 'unknown' };

  const clear = forecast.find(p => p.minutes <= threshold);
  if (clear) return { kind: 'clears', offset: clear.offset, minutes: clear.minutes };

  // Earliest point on ties — no reason to wait longer for the same drive.
  const best = forecast.reduce((a, b) => (b.minutes < a.minutes ? b : a));
  const low  = Math.min(currentMin, best.minutes);
  const high = Math.max(currentMin, ...forecast.map(p => p.minutes));

  if (currentMin - best.minutes < MIN_WORTHWHILE_SAVING_MIN) {
    return { kind: 'flat', low, high };
  }

  // Alert as soon as live traffic is worthwhile-better than now rather than at
  // the forecast minimum itself: live conditions rarely land exactly on the
  // forecast, and a watch whose threshold is never met polls indefinitely.
  return {
    kind: 'improves',
    offset: best.offset,
    minutes: best.minutes,
    watchThreshold: currentMin - MIN_WORTHWHILE_SAVING_MIN,
  };
}
