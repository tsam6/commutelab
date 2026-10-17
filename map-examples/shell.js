// Shared CommuteLab frame for both map examples: header, floating pills, HALF bottom sheet and tab bar.
// Each page calls renderFrame({ legend }) and then draws its own map into #map.
(function () {
  const E = window.EXAMPLE;
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  // Lucide icon paths (ISC licence), inlined so the examples need no icon package.
  const IC = {
    nav: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
    chev: '<path d="m6 9 6 6 6-6"/>',
    sliders: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
    user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    expand: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
  };
  const ic = (k) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${IC[k]}</svg>`;
  window.ic = ic;
  window.fmt = fmt;

  // Ghost = where the typical (P50) commute would be right now: 42 s behind = ~525 m back on the express.
  E.ghostAheadSec = 42;

  window.renderFrame = function ({ legend }) {
    const p = E.phases;
    const stages = [
      { k: 'Bike', s: p.bike, c: 'var(--c-bike)' },
      { k: 'Wait', s: p.wait, c: 'var(--c-wait)' },
      { k: '6 local', s: p.train1, c: 'var(--c-train)' },
      { k: 'Transfer', s: p.transfer, c: 'var(--c-transfer)' },
      { k: '4/5 express', s: p.train2, c: 'var(--c-train)', live: true },
    ];
    document.getElementById('app').innerHTML = `
      <div class="phone">
        <header class="top">
          <div class="top-left">
            <div class="mark">${ic('nav')}</div>
            <div class="dest"><span>${E.title}</span>${ic('chev')}</div>
          </div>
          <div style="display:flex;gap:6px">
            <div class="icon-btn">${ic('sliders')}</div><div class="icon-btn">${ic('user')}</div>
          </div>
        </header>
        <div class="map">
          <div id="map" role="img" aria-label="Map of the commute from the East Village to Hunter College"></div>
          <div class="pills">
            <div class="pill"><span class="dot"></span>On the 4/5 express <small>· underground</small></div>
            <div class="pill num">${ic('clock')}Next: 59 St <small>· ~${Math.max(1, Math.round(pathLen(E.ahead[0]) / 12.5 / 60))} min</small></div>
          </div>
          <div class="legend">${legend}</div>
        </div>
        <section class="sheet">
          <div class="sheet-top">
            <span class="gps">Live GPS (±8m)</span><span class="grip"></span>
            <span class="detents"><b>PEEK</b><b class="on">HALF</b><b>FULL</b></span>
          </div>
          <div class="clock-row">
            <div>
              <div class="kicker">Route 1A clock <span class="ghost num">−${fmt(E.ghostAheadSec)} vs P50</span></div>
              <div class="clock num">${fmt(E.clock)}</div>
            </div>
            <div class="side num">Walk buffer <b>${fmt(p.walk)}</b><div class="now">Off at 59 St → 6 local</div></div>
          </div>
          <div class="cands">${E.strategies.map((s) => `<span class="cand${s.alive ? '' : ' out'}"><span class="b" style="background:${s.color}">${s.id}</span>${s.label}</span>`).join('')}</div>
          <div class="pipe">${stages.map((s) => `<div class="${s.live ? 'live' : ''}" style="--w:${s.s};--c:${s.c}"><i></i><span>${s.k} <b class="num">${fmt(s.s)}</b></span></div>`).join('')}</div>
        </section>
        <nav>
          <a class="on">${ic('nav')}Corridor</a><a>${ic('activity')}Benchmark</a><a>${ic('layers')}Ledger</a>
        </nav>
      </div>`;
  };

  // --- small geo helpers shared by both pages ([lat, lon] points)
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  window.hav = (a, b) => {
    const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  window.pathLen = (p) => p.slice(1).reduce((sum, q, i) => sum + window.hav(p[i], q), 0);
  /** Point `back` metres before the end of `path`. */
  window.pointBack = (path, back) => {
    for (let i = path.length - 1; i > 0; i--) {
      const seg = window.hav(path[i - 1], path[i]);
      if (back <= seg) {
        const t = 1 - back / seg;
        return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t];
      }
      back -= seg;
    }
    return path[0];
  };
})();
