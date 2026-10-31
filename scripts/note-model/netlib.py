import numpy as np, json, re, torch, torch.nn as nn, collections
P = 287; SR = 44100; HOP = 512; FPS = SR / HOP
HARM = [1, 2, 3, 4, 5, 6, 8]
DECODE_OVERRIDE = {}
def load(name):
    meta = json.load(open(f"feat_{name}_meta.json")); F = meta['frames']
    X = np.stack([np.fromfile(f"feat_{name}_h{h}.u8", np.uint8).reshape(F, P) for h in HARM]).astype(np.float32) / 255.0 * 80.0 - 80.0
    t = np.load(f"targets_{name}.npz")
    return dict(name=name, X=X, active=t['active'].astype(np.float32), onset=t['onset'].astype(np.float32), weight=t['weight'].astype(np.float32),
                notes=t['notes'], tracks=t['note_tracks'], F=F)

def smear_onset(on):
    o = on.copy(); o[1:] = np.maximum(o[1:], on[:-1]); o[:-1] = np.maximum(o[:-1], on[1:]); return o

def parse_shifts(s):
    return [(HARM.index(int(h)), int(sh)) for h, sh in (tok.split(':') for tok in s.split(',') if tok.strip())]

def parse_arch(s):
    out = []
    for tok in s.split(','):
        m = re.fullmatch(r'(\d+)x(\d+)x(\d+)(?:t(\d+))?(?:b(\d+))?', tok.strip()); out.append((int(m[1]), int(m[2]), int(m[3]), int(m[4] or 1), int(m[5] or 1)))
    return out

class Net(nn.Module):
    def __init__(self, shifts, arch, norm):
        super().__init__()
        self.shifts = shifts; self.norm = norm
        cin = len(HARM) + len(shifts); mods = []; macs = 0
        for c, kt, kp, dt, dp in arch:
            mods += [nn.Conv2d(cin, c, (kt, kp), padding=(dt * (kt // 2), dp * (kp // 2)), dilation=(dt, dp)), nn.ReLU()]
            macs += cin * c * kt * kp; cin = c
        head = nn.Conv2d(cin, 2, 1); macs += cin * 2
        with torch.no_grad(): head.bias.copy_(torch.tensor([-3.0, -5.0]))
        mods.append(head); self.net = nn.Sequential(*mods); self.macs = macs
    def features(self, x):
        x = (x + 40.0) / 40.0
        chans = [x]
        for hi, sh in self.shifts:
            pl = x[:, hi]; z = torch.full_like(pl, -1.0)
            if sh < 0: z[:, :, -sh:] = pl[:, :, :sh]
            elif sh > 0: z[:, :, :-sh] = pl[:, :, sh:]
            else: z = pl
            chans.append(z[:, None])
        f = torch.cat(chans, 1)
        if self.norm == 'frame': f = f - x[:, 0:1].amax(dim=3, keepdim=True)
        return f
    def forward(self, x): return self.net(self.features(x))

def predict(net, d):
    net.eval()
    with torch.no_grad():
        x = torch.from_numpy(d['X'])[None]
        logits = torch.cat([net(x[:, :, s:e]) for s, e in [(i, min(i + 2048, d['F'])) for i in range(0, d['F'], 2048)]], dim=2)[0]
        prob = torch.sigmoid(logits).numpy()
    net.train(); return prob

def note_metrics(pred, gt, tol_step=0, onset_tol=0.05):
    used = np.zeros(len(gt), bool); tp = 0; g = np.array(gt) if len(gt) else np.zeros((0, 3))
    for t0, t1, p in pred:
        if not len(gt): break
        m = (~used) & (np.abs(g[:, 2] - p) <= tol_step) & (np.abs(g[:, 0] - t0) <= onset_tol); idx = np.where(m)[0]
        if len(idx): used[idx[0]] = True; tp += 1
    pr = tp / max(len(pred), 1); rc = tp / max(len(gt), 1)
    return pr, rc, 2 * pr * rc / max(pr + rc, 1e-9), used

def decode(prob):
    import decode_v2 as D
    params = dict(D.DEFAULT); params.update(DECODE_OVERRIDE)
    return [(s / FPS, e / FPS, b) for s, e, b, c in D.decode_notes(prob[0], prob[1], params)]

def evaluate(net, d, label, f_lo, f_hi, prob=None):
    """metrics restricted to frames [f_lo, f_hi) (41edo region only via weight)"""
    if prob is None: prob = predict(net, d)
    w = d['weight'] > 0; w[:f_lo] = False; w[f_hi:] = False
    act = prob[0][w]; gt = d['active'][w]; pred = act > 0.5
    tp = (pred & (gt > 0)).sum(); fp = (pred & (gt == 0)).sum(); fn = ((~pred) & (gt > 0)).sum()
    fpr = tp / max(tp + fp, 1); frc = tp / max(tp + fn, 1); ff1 = 2 * fpr * frc / max(fpr + frc, 1e-9)
    lo, hi = f_lo / FPS, min(f_hi, int(w.sum() + f_lo)) / FPS if False else f_hi / FPS
    tmax41 = (d['weight'] > 0).sum() / FPS
    hi = min(hi, tmax41)
    from gt_dedupe import dedupe_gt
    gtn = dedupe_gt([tuple(n) for n in d['notes'] if lo <= n[0] < hi])
    notes = [n for n in decode(prob) if lo <= n[0] < hi]
    p0, r0, f0, used = note_metrics(notes, gtn, 0); _, _, f1, _ = note_metrics(notes, gtn, 1)
    trk = {(round(n[0], 4), int(n[2])): t for n, t in zip(d['notes'], d['tracks'])}
    tr_sel = [trk.get((round(g[0], 4), int(g[2])), '?') for g in gtn]
    tot = collections.Counter(tr_sel); hit = collections.Counter(t for u, t in zip(used, tr_sel) if u)
    by = ', '.join(f"{t}={hit[t] / tot[t]:.2f}({tot[t]})" for t in sorted(tot))
    print(f"  [{label}] frame P/R/F1 = {fpr:.3f}/{frc:.3f}/{ff1:.3f} | notes pred={len(notes)} gt={len(gtn)} exact P/R/F1={p0:.3f}/{r0:.3f}/{f0:.3f} ±1step F1={f1:.3f} | {by}", flush=True)
    return dict(ff1=ff1, nf1=f0, np=p0, nr=r0)

def export_json(net, path, version, decode_params):
    layers = []; mods = list(net.net); i = 0
    while i < len(mods):
        m = mods[i]; kt, kb = m.kernel_size; dt, db = m.dilation
        act = 'relu' if i + 1 < len(mods) and isinstance(mods[i + 1], nn.ReLU) else 'none'
        layers.append({"in": m.in_channels, "out": m.out_channels, "kt": kt, "kb": kb, "dt": dt, "db": db,
                       "w": [round(float(v), 6) for v in m.weight.detach().reshape(-1)], "b": [round(float(v), 6) for v in m.bias.detach()], "act": act})
        i += 2 if act == 'relu' else 1
    doc = {"version": version,
           "input": {"harmonics": HARM, "shifts": [{"harmonic": HARM[hi], "bins": sh} for hi, sh in net.shifts],
                     "dbMin": -80, "dbMax": 0, "offset": 40.0, "scale": 40.0, "norm": net.norm},
           "layers": layers, "decode": decode_params}
    json.dump(doc, open(path, 'w'), separators=(',', ':'))
    print("exported", path, "params", sum(len(l['w']) + len(l['b']) for l in layers), "MACs/cell", net.macs)

