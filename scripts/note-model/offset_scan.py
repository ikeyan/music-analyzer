# GT の時間オフセットの検算: 予測ノートの onset を ±60 ms ずらして note F1 が最大になる shift を見る
import sys, numpy as np, torch
from netlib import load, smear_onset, note_metrics, FPS
import netlib, decode_v2 as D
from gt_dedupe import dedupe_gt
from json_to_pt import load_json_model
from eval_model import predict_any
net, _ = load_json_model(sys.argv[1])
for name in sys.argv[2].split(','):
    d = load(name); prob = predict_any(net, d)
    tmax = (d['weight'] > 0).sum() / FPS
    notes = [(s / FPS, e / FPS, b) for s, e, b, c in D.decode_notes(prob[0], prob[1], dict(D.DEFAULT)) if s / FPS < tmax]
    gt = dedupe_gt([tuple(n) for n in d['notes'] if n[0] < tmax])
    row = []
    for sh in np.arange(-0.06, 0.061, 0.01):
        shifted = [(a + sh, b + sh, p) for a, b, p in notes]
        row.append((round(sh * 1000), round(note_metrics(shifted, gt, 0)[2], 3)))
    best = max(row, key=lambda r: r[1])
    print(f"[{name}] F1 vs prediction shift (ms): {row} -> best {best}")
