# note decoder (app/lib/note-decode.ts と同じ段階構成・意味論)。DEFAULT が学習時に決めた推奨値。
# DEFAULT_REF は全段階を無効にした最小構成 (閾値 + 隣接 bin ピーク + onset 分割のみ)
import numpy as np

DEFAULT_REF = dict(onThreshold=0.5, offThreshold=0.3, onsetThreshold=0.5, minFrames=3,
                   smooth=1, splitMinFrames=1, mergeGap=0, mergeOnsetBlock=True, minFramesFinal=0,
                   nmsBins=0, nmsOverlap=0.5, nmsMode='mean',
                   harmMargin=None, harmOverlap=0.5, harmOffsets=(41, 65, 82),
                   minConf=0.0, backtrack=0, onsetSnap=0)
# recommended set (tuned jointly on kipa/m_cnn_k2x and xenprog/m_cnn_x2k, see report_decoder.md)
DEFAULT = dict(DEFAULT_REF, smooth=9, onThreshold=0.6, offThreshold=0.1, onsetThreshold=0.5, splitMinFrames=5, mergeGap=8,
               minFrames=8, backtrack=5, nmsBins=1, nmsOverlap=0.3, nmsMode='sum', harmMargin=0.0, harmOverlap=0.3, harmOffsets=(41,))
# 2 パスモデルの最終出力用 (assemble_v2.py が書き込む)。pass 1 (テンプレート用の検出) は DEFAULT のまま
FINAL = dict(DEFAULT, smooth=5, mergeGap=0)

def moving_mean(x, w):
    if w <= 1: return x
    k = w // 2
    c = np.cumsum(np.pad(x, ((k + 1, k), (0, 0))), axis=0)
    return (c[w:] - c[:-w]) / w   # zero-padded at the edges

def _segments(active, onset, p):
    F, B = active.shape
    onT, offT, onsT, minF, splitMin = p['onThreshold'], p['offThreshold'], p['onsetThreshold'], p['minFrames'], p['splitMinFrames']
    left = np.full_like(active, -np.inf); left[:, 1:] = active[:, :-1]
    right = np.full_like(active, -np.inf); right[:, :-1] = active[:, 1:]
    peak_bin = (active > left) & (active >= right)
    prev = np.full_like(onset, -np.inf); prev[1:] = onset[:-1]
    nxt = np.full_like(onset, -np.inf); nxt[:-1] = onset[1:]
    peak_on = (onset >= onsT) & (onset >= prev) & (onset > nxt)
    notes = []
    for b in range(B):
        col = active[:, b]
        cand = np.flatnonzero(col >= offT)
        if len(cand) == 0: continue
        pb = peak_bin[:, b]; po = peak_on[:, b]
        breaks = np.flatnonzero(np.diff(cand) > 1)
        run_starts = np.concatenate([[cand[0]], cand[breaks + 1]]); run_ends = np.concatenate([cand[breaks], [cand[-1]]]) + 1
        for r0, r1 in zip(run_starts, run_ends):
            start = -1; s = 0.0; prev_end = 0
            for f in range(r0, r1):
                v = col[f]
                if start < 0:
                    if v >= onT and pb[f]:
                        start = f; s = v
                        lo = max(r0, prev_end, f - p['backtrack'])
                        if p['onsetSnap'] > 0:
                            ks = [k for k in range(max(r0, prev_end, f - p['onsetSnap']), f) if po[k]]
                            if ks: lo = ks[0]
                        if lo < f: start = lo; s = float(col[lo:f + 1].sum())
                    continue
                if f - start >= splitMin and po[f]:
                    if f - start >= minF: notes.append([start, f, b, s / (f - start)])
                    prev_end = f; start = -1; s = 0.0
                    if v >= onT: start = f; s = v
                    continue
                s += v
            if start >= 0 and r1 - start >= minF: notes.append([start, r1, b, s / (r1 - start)])
    return notes

def _merge_gaps(notes, onset, p):
    gap = p['mergeGap']
    if gap <= 0: return notes
    onsT = p['onsetThreshold']; out = []
    bybin = {}
    for n in sorted(notes, key=lambda n: (n[2], n[0])): bybin.setdefault(n[2], []).append(n)
    for b, ns in bybin.items():
        cur = ns[0]
        for n in ns[1:]:
            blocked = p['mergeOnsetBlock'] and onset[n[0], b] >= onsT
            if n[0] - cur[1] <= gap and not blocked:
                d0 = cur[1] - cur[0]; d1 = n[1] - n[0]
                cur = [cur[0], n[1], b, (cur[3] * d0 + n[3] * d1) / (d0 + d1)]
            else: out.append(cur); cur = n
        out.append(cur)
    return out

def _overlap(a, b):
    return max(0, min(a[1], b[1]) - max(a[0], b[0]))

def _strength(n, mode):
    return n[3] if mode == 'mean' else n[3] * (n[1] - n[0])

def _nms(notes, p):
    k = p['nmsBins']
    if k <= 0: return notes
    mode = p['nmsMode']; frac = p['nmsOverlap']
    order = sorted(range(len(notes)), key=lambda i: -_strength(notes[i], mode))
    bybin = {}
    for i, n in enumerate(notes): bybin.setdefault(n[2], []).append(i)
    alive = [True] * len(notes)
    for i in order:
        if not alive[i]: continue
        n = notes[i]
        for db in range(-k, k + 1):
            if db == 0: continue
            for j in bybin.get(n[2] + db, []):
                if not alive[j] or j == i: continue
                m = notes[j]
                if _overlap(n, m) > frac * min(n[1] - n[0], m[1] - m[0]): alive[j] = False
    return [n for i, n in enumerate(notes) if alive[i]]

def _harmonic(notes, p):
    margin = p['harmMargin']
    if margin is None: return notes
    frac = p['harmOverlap']
    bybin = {}
    for i, n in enumerate(notes): bybin.setdefault(n[2], []).append(i)
    keep = []
    for n in notes:
        drop = False
        for off in p['harmOffsets']:
            for j in bybin.get(n[2] - off, []):
                m = notes[j]
                if _overlap(n, m) > frac * (n[1] - n[0]) and m[3] >= n[3] + margin: drop = True; break
            if drop: break
        if not drop: keep.append(n)
    return keep

def decode_notes(active, onset, p=None):
    q = dict(DEFAULT if p is None else DEFAULT_REF); q.update(p or {})
    a = moving_mean(active, q['smooth'])
    notes = _segments(a, onset, q)
    notes = _merge_gaps(notes, onset, q)
    if q['minFramesFinal'] > 0: notes = [n for n in notes if n[1] - n[0] >= q['minFramesFinal']]
    if q['minConf'] > 0: notes = [n for n in notes if n[3] >= q['minConf']]
    notes = _nms(notes, q)
    notes = _harmonic(notes, q)
    notes = [tuple(n) for n in notes]
    notes.sort(key=lambda n: (n[0], n[2]))
    return notes
