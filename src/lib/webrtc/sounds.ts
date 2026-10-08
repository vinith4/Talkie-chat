let ctx: AudioContext | null = null;

function ac(): AudioContext | null {
  if (!ctx) {
    try { ctx = new AudioContext(); } catch { return null; }
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(freqs: number[], start: number, dur: number, vol = 0.12) {
  const c = ac();
  if (!c) return;
  const t = c.currentTime + start;
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.02);
  g.gain.setValueAtTime(vol, Math.max(t + 0.02, t + dur - 0.03));
  g.gain.linearRampToValueAtTime(0, t + dur);
  g.connect(c.destination);
  for (const f of freqs) {
    const o = c.createOscillator();
    o.frequency.value = f;
    o.connect(g);
    o.start(t);
    o.stop(t + dur);
  }
}

/** "ringtone" = what the person being called hears; "ringback" = what the caller hears. Returns a stop function. */
export function startRing(kind: "ringtone" | "ringback"): () => void {
  const cycle = () => {
    if (kind === "ringtone") {
      [880, 660, 880, 660].forEach((f, i) => tone([f], i * 0.28, 0.24));
      try { navigator.vibrate?.([300, 150, 300]); } catch { /* not supported */ }
    } else {
      tone([440, 480], 0, 1.5);
    }
  };
  cycle();
  const id = setInterval(cycle, kind === "ringtone" ? 3000 : 4000);
  return () => { clearInterval(id); try { navigator.vibrate?.(0); } catch { /* ignore */ } };
}

export function chime(type: "connect" | "end") {
  if (type === "connect") { tone([880], 0, 0.12); tone([1175], 0.14, 0.2); }
  else { tone([480], 0, 0.15); tone([380], 0.18, 0.15); tone([300], 0.36, 0.25); }
}
