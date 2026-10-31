# synthetic 41edo polyphonic training pieces with random additive timbres (exact ground truth)
import numpy as np, json, sys
SR = 44100; C0 = 440 * 2 ** (-(9 + 48) / 12)
SINE_PROB = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
def step_hz(s): return C0 * 2 ** (s / 41)
def make_instrument(rng, kind):
    nh = int(rng.integers(4, 24)); alpha = rng.uniform(0.4, 2.5)
    amps = np.arange(1, nh + 1) ** (-alpha) * rng.uniform(0.5, 1.5, nh)
    # 倍音のほぼ無い音 (サブベース等のサイン波) も混ぜる。SINE_PROB は argv[4]
    if rng.random() < SINE_PROB: amps = np.concatenate([[1.0], np.zeros(nh - 1)])
    if rng.random() < 0.3: amps[1::2] *= rng.uniform(0.05, 0.4)   # odd-harmonic-ish (square/clarinet)
    if rng.random() < 0.3: amps[0] *= rng.uniform(0.1, 0.5)       # weak fundamental
    sub = rng.uniform(0.3, 1.0) if (kind == 'bass' and rng.random() < 0.6) else 0.0
    unison = int(rng.choice([1, 1, 1, 3, 5, 7])); spread = rng.uniform(3, 25) if unison > 1 else 0.0  # cents
    return dict(amps=amps / amps.max(), sub=sub, unison=unison, spread=spread, attack=rng.uniform(0.003, 0.08), decay=rng.uniform(0.05, 1.0),
                sustain=rng.uniform(0.2, 1.0) if rng.random() < 0.7 else 0.0, release=rng.uniform(0.02, 0.4),
                brightness_decay=rng.uniform(0.0, 3.0), gain=rng.uniform(0.15, 0.5), detune=rng.uniform(0, 0.4))
def render_note(inst, f, dur, rng):
    n = int((dur + inst['release']) * SR); t = np.arange(n) / SR
    env = np.ones(n)
    a = max(1, int(inst['attack'] * SR)); env[:a] = np.linspace(0, 1, a)
    d = inst['decay']; sus = inst['sustain']
    env *= sus + (1 - sus) * np.exp(-np.maximum(t - inst['attack'], 0) / d)
    r0 = int(dur * SR); rl = max(1, n - r0); env[r0:] *= np.linspace(1, 0, rl)
    y = np.zeros(n)
    voices = [0.0] if inst.get('unison', 1) == 1 else list(np.linspace(-inst['spread'], inst['spread'], inst['unison']))
    for vc in voices:
        fv = f * 2 ** (vc / 1200)
        for k, a_k in enumerate(inst['amps'], 1):
            fk = fv * k
            if fk > SR * 0.45: break
            det = 1 + inst['detune'] * 1e-3 * rng.standard_normal()
            henv = np.exp(-t * inst['brightness_decay'] * (k - 1) / len(inst['amps']))
            y += a_k * henv * np.sin(2 * np.pi * fk * det * t + rng.uniform(0, 2 * np.pi)) / len(voices) ** 0.5
    if inst['sub'] > 0: y += inst['sub'] * np.sin(2 * np.pi * (f / 2) * t)
    return y * env * inst['gain']
def make_piece(seed, dur_sec=60.0):
    rng = np.random.default_rng(seed)
    x = np.zeros(int(dur_sec * SR) + SR); notes = []
    n_inst = int(rng.integers(1, 4))
    kinds = ['bass', 'chords', 'lead', 'pad']; rng.shuffle(kinds)
    grid = rng.choice([0.1, 0.125, 0.15, 0.2, 0.25, 0.3])
    for kind in kinds[:n_inst]:
        inst = make_instrument(rng, kind)
        lo, hi = {'bass': (41, 130), 'chords': (110, 240), 'lead': (150, 270), 'pad': (100, 250)}[kind]
        poly = {'bass': 1, 'chords': int(rng.integers(2, 5)), 'lead': 1, 'pad': int(rng.integers(2, 4))}[kind]
        t = rng.uniform(0, 1.0)
        # scale: random subset of 41edo steps to make it musical-ish (also gives repeated pitches)
        scale = rng.choice(41, size=int(rng.integers(5, 12)), replace=False)
        cur = None
        while t < dur_sec - 0.5:
            dur = float(rng.choice([grid, grid * 2, grid * 3, grid * 4, grid * 8])) * rng.uniform(0.6, 1.0) if kind != 'pad' else float(rng.uniform(0.8, 3.0))
            gap = 0.0 if rng.random() < 0.6 else float(rng.choice([grid, grid * 2]))
            if rng.random() < 0.15:  # rest
                t += dur + gap; continue
            if cur is None or rng.random() < 0.7 or kind == 'bass':
                base = int(rng.integers(lo, hi))
                cur = sorted(set(int(np.clip(base + 41 * ((s - scale[0]) // 41) + (s - scale[0]) % 41, lo, hi)) for s in rng.choice(scale, size=poly, replace=False)))
                cur = [(c // 41) * 41 + (c % 41) for c in cur]
            for s in cur:
                f = step_hz(s); y = render_note(inst, f, dur, rng)
                i0 = int(t * SR); i1 = min(len(x), i0 + len(y)); x[i0:i1] += y[:i1 - i0]
                notes.append((round(t, 4), round(t + dur, 4), int(s)))
            t += dur + gap
    x = x[:int(dur_sec * SR)]
    peak = np.abs(x).max() + 1e-9; x = x / peak * rng.uniform(0.3, 0.9)
    if rng.random() < 0.5: x += rng.uniform(0.0005, 0.005) * rng.standard_normal(len(x))  # noise floor
    return x.astype(np.float32), notes
if __name__ == '__main__':
    n = int(sys.argv[1]); dur = float(sys.argv[2]); start = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    for i in range(start, start + n):
        x, notes = make_piece(1000 + i, dur)
        name = f"syn{i:02d}"
        x.tofile(f"{name}_44100.f32"); json.dump(notes, open(f"{name}_notes.json", 'w'))
        print(name, len(notes), "notes", f"{len(x)/SR:.1f}s", "poly max", max(sum(1 for a in notes if a[0] <= t < a[1]) for t in np.arange(0, dur, 0.5)))
