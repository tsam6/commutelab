export const formatMinSec = (sec: number) => {
  if (sec == null || !isFinite(sec)) return '—';
  const safe = Math.max(0, Math.round(Math.abs(sec)));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${s < 10 ? '0' : ''}${s}`;
};

export const formatMinutesDecimal = (sec: number) => (sec == null || !isFinite(sec) ? '—' : `${(sec / 60).toFixed(1)}m`);

/** "+1:07" / "−0:42" (true minus sign). */
export const signed = (sec: number) => `${sec < 0 ? '−' : '+'}${formatMinSec(sec)}`;

export const toMph = (metersPerSec: number) => (metersPerSec || 0) * 2.23694;

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Today", "Yesterday", or "Oct 12". */
export function dayLabel(t: number, now = Date.now()) {
  const diff = Math.round((startOfDay(now) - startOfDay(t)) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export const timeLabel = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const pct = (v: number) => (isFinite(v) ? `${Math.round(v * 100)}%` : '—');
