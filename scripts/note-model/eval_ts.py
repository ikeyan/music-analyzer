# evaluate a NoteEstimationResult JSON (from the TS path) against MIDI ground truth
import numpy as np, json, sys
C4 = 261.6256
CFG = {
  'kipa': {'off': 0.9636, 'edo12_from': None},
  'xenprog': {'off': 0.4325, 'edo12_from': 174.375},
  'yxeni': {'off': 0.4354, 'edo12_from': None}, 'mafle': {'off': 0.238, 'edo12_from': None}, 'fnas': {'off': 0.4992, 'edo12_from': None},
}
name, path = sys.argv[1], sys.argv[2]
SR, HOP = 44100, 512
res = json.load(open(path)); cfg = CFG[name]
t = np.load(f"targets_{name}.npz"); gt = t['notes']; tracks = t['note_tracks']
tmax = (cfg['edo12_from'] + cfg['off']) if cfg['edo12_from'] is not None else 1e9
from gt_dedupe import dedupe_gt
gt_raw = [(a, b, int(p), tr) for (a, b, p), tr in zip(gt, tracks) if a < tmax]
gt_sel = dedupe_gt(gt_raw)
print(f'  gt notes {len(gt_raw)} -> {len(gt_sel)} after merging same-bin doublings')
pred = [(n['onsetSec'], n['offsetSec'], n['step'] - 41, n['confidence']) for n in res['notes'] if n['onsetSec'] < tmax]
def match(pred, gt, tol_step=0, onset_tol=0.05):
    used = np.zeros(len(gt), bool); g = np.array([(a, b, p) for a, b, p, _ in gt]); tp = 0
    hits = []
    for t0, t1, p, c in pred:
        m = (~used) & (np.abs(g[:, 2] - p) <= tol_step) & (np.abs(g[:, 0] - t0) <= onset_tol)
        idx = np.where(m)[0]
        if len(idx): used[idx[0]] = True; tp += 1
    prec = tp / max(len(pred), 1); rec = tp / max(len(gt), 1)
    return prec, rec, 2 * prec * rec / max(prec + rec, 1e-9), used
p0, r0, f0, used = match(pred, gt_sel)
p1, r1, f1, _ = match(pred, gt_sel, 1)
print(f"[{name}] TS path: pred={len(pred)} gt={len(gt_sel)} exact-step onset±50ms P/R/F1 = {p0:.3f}/{r0:.3f}/{f0:.3f} | ±1 step F1 = {f1:.3f}")
import collections
tot = collections.Counter(tr for *_, tr in gt_sel); hit = collections.Counter(tr for (a, b, p, tr), u in zip(gt_sel, used) if u)
print("  recall by track:", {k: f"{hit[k]/tot[k]:.3f} ({tot[k]})" for k in tot})
# frame-level
F = res['frames']; fps = SR / HOP
A = np.zeros((F, 287), bool); G = np.zeros((F, 287), bool)
for t0, t1, p, c in pred:
    if 0 <= p < 287: A[int(round(t0 * fps)):int(round(t1 * fps)), p] = True
for a, b, p, _ in gt_sel:
    if 0 <= p < 287: G[int(round(a * fps)):int(round(b * fps)), p] = True
lim = int(min(F, tmax * fps)); A = A[:lim]; G = G[:lim]
tp = (A & G).sum(); fp = (A & ~G).sum(); fn = (~A & G).sum()
pr = tp / max(tp + fp, 1); rc = tp / max(tp + fn, 1)
print(f"  frame-level P/R/F1 = {pr:.3f}/{rc:.3f}/{2*pr*rc/max(pr+rc,1e-9):.3f}")
