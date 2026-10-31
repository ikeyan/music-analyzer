import numpy as np, json, sys
SR = 44100
name = sys.argv[1]; OFF = float(sys.argv[2])
x = np.fromfile(f"{name}_44100.f32", dtype=np.float32); notes = json.load(open(f"{name}_notes.json"))
grid = np.arange(-4500, 5500, 1.0); grid_hz = 440.0 * 2 ** (grid / 1200)
NFFT = 1 << 16; freqs = np.fft.rfftfreq(NFFT, 1/SR)
K = 6; wk = 0.85 ** np.arange(K); shifts = np.round(1200*np.log2(np.arange(1, K+1))).astype(int)
def note_hs(n):
    a = n['t0'] + OFF + 0.02; b = min(n['t1'] + OFF, n['t0'] + OFF + 0.6) - 0.01
    if b - a < 0.08: b = a + 0.08
    i0, i1 = int(a*SR), int(b*SR)
    if i1 > len(x) or i0 < 0: return None
    seg = x[i0:i1] * np.hanning(i1-i0)
    S = np.log10(np.interp(grid_hz, freqs, np.abs(np.fft.rfft(seg, NFFT))) + 1e-6); S -= S.max()
    S = np.maximum(S, -4) + 4
    hs = np.zeros(len(grid))
    for k in range(K):
        s = shifts[k]; hs[:len(grid)-s] += wk[k] * S[s:]
    return hs
def scan(sel, spo):
    step_c = 1200/spo; acc = np.zeros(len(grid)); cnt = 0
    for n in sel:
        if n.get('bends') and any(v != 0 for _, v in n['bends']): continue
        hs = note_hs(n)
        if hs is None: continue
        sh = int(round((n['note']-60)*step_c))
        if sh >= 0: acc[:len(grid)-sh] += hs[sh:]
        else: acc[-sh:] += hs[:len(grid)+sh]
        cnt += 1
    acc /= max(cnt,1)
    peaks = sorted([j for j in range(1,len(acc)-1) if acc[j]>acc[j-1] and acc[j]>=acc[j+1]], key=lambda j:-acc[j])
    return cnt, [(round(440*2**(grid[j]/1200),2), round(grid[j]+900), round(acc[j],3)) for j in peaks[:5]]
tracks = sorted(set(n['track'] for n in notes))
for tr in tracks:
    spo = 41 if tr.endswith('41edo') else 12
    cnt, peaks = scan([n for n in notes if n['track']==tr], spo)
    print(f"[{name}] {tr} (@{spo}): n={cnt} f(60) candidates (Hz, cents rel C4, score): {peaks}")
