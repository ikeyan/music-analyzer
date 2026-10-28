# wav と MIDI の時間オフセット: spectral flux と MIDI onset 列の相互相関 (音声先頭の立ち上がり付近を優先)
import numpy as np, json, sys
SR = 44100
name = sys.argv[1]
x = np.fromfile(f"{name}_44100.f32", np.float32); notes = json.load(open(f"{name}_notes.json"))
def flux(x, n_fft=2048, hop=128):
    win = np.hanning(n_fft).astype(np.float32); nfr = (len(x) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(nfr)[:, None]
    out = np.zeros(nfr); prev = None
    for i0 in range(0, nfr, 4096):
        m = np.log1p(100 * np.abs(np.fft.rfft(x[idx[i0:i0 + 4096]] * win, axis=1)))
        if prev is None: prev = m[:1]
        d = np.diff(np.concatenate([prev, m]), axis=0); out[i0:i0 + len(m)] = np.maximum(d, 0).sum(1); prev = m[-1:]
    return out, hop
fl, hop = flux(x)
fl = fl - np.convolve(fl, np.ones(41) / 41, mode='same')
on = np.zeros_like(fl)
for n in notes:
    i = int(round(n['t0'] * SR / hop))
    if i < len(on): on[i] += 1
first_audio = np.argmax(np.abs(x) > 0.01) / SR
first_midi = min(n['t0'] for n in notes)
lo, hi = -0.5, 2.0
lags = np.arange(int(lo * SR / hop), int(hi * SR / hop) + 1)
cc = np.array([np.dot(fl[max(0, l):len(fl) + min(0, l)], on[max(0, -l):len(on) + min(0, -l)]) for l in lags])
order = np.argsort(cc)[::-1][:8]
print(f"[{name}] audio first |x|>0.01 at {first_audio:.3f}s, midi first onset {first_midi:.3f}s (envelope offset ≈ {first_audio - first_midi:+.3f}s)")
print("  cc peaks (offset s, rel):", [(round(lags[i] * hop / SR, 4), round(cc[i] / cc.max(), 3)) for i in order])
