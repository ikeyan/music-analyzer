# final trainer: both songs jointly, time-based holdout, export to app/lib/note-model.json format
import numpy as np, json, sys, re, argparse, time, torch, torch.nn as nn, torch.nn.functional as Fn, collections
P = 287; SR = 44100; HOP = 512; FPS = SR / HOP
HARM = [1, 2, 3, 4, 5, 6, 8]
ap = argparse.ArgumentParser()
ap.add_argument('--songs', default='kipa,xenprog')
ap.add_argument('--train_extra', default='', help='comma list of extra training-only pieces (e.g. synthetic)')
ap.add_argument('--extra_weight', type=float, default=1.0, help='sampling weight multiplier for extra pieces')
ap.add_argument('--eval_songs', default='', help='comma list of songs evaluated in full but not trained on')
ap.add_argument('--holdout', type=float, default=0.2, help='fraction of each song 41edo region (tail) held out')
ap.add_argument('--epochs', type=int, default=40); ap.add_argument('--lr', type=float, default=2e-3)
ap.add_argument('--crop', type=int, default=256); ap.add_argument('--batch', type=int, default=8)
ap.add_argument('--steps_mult', type=int, default=4)
ap.add_argument('--save', default='m_final.pt'); ap.add_argument('--export', default='')
ap.add_argument('--version', default='edo41-cnn-v1')
ap.add_argument('--seed', type=int, default=0)
ap.add_argument('--gain_aug', type=float, default=12.0); ap.add_argument('--noise_aug', type=float, default=1.0)
ap.add_argument('--shift_aug', type=int, default=0)
ap.add_argument('--shifts', default='1:-41,1:-65,1:-82')
ap.add_argument('--norm', default='none')
ap.add_argument('--arch', default='24x3x9,24x1x15,16x5x1t2,16x5x1t4,16x3x3')
ap.add_argument('--tail_frames', type=int, default=0, help='frames after note-off treated as don\'t-care for the active head'); ap.add_argument('--tail_w', type=float, default=0.0)
ap.add_argument('--pos_w', default='3,10'); ap.add_argument('--margin_w', type=float, default=1.0); ap.add_argument('--onset_w', type=float, default=1.0)
ap.add_argument('--decode_params', default='', help='json dict overriding decoder params')
ap.add_argument('--threads', type=int, default=8)
ap.add_argument('--eval_every', type=int, default=5)
args = ap.parse_args()
torch.set_num_threads(args.threads); torch.manual_seed(args.seed); np.random.seed(args.seed)

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
    params = dict(D.DEFAULT); params.update(json.loads(args.decode_params) if args.decode_params else {})
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

if __name__ == '__main__':
    songs = [load(n) for n in args.songs.split(',') if n]
    for d in songs:
        n41 = int((d['weight'] > 0).sum()); d['f_train_hi'] = int(n41 * (1 - args.holdout)); d['f_val_lo'] = d['f_train_hi']; d['f_val_hi'] = n41
        d['on'] = smear_onset(d['onset']); d['samp'] = 1.0
        print(f"{d['name']}: frames {d['F']}, 41edo frames {n41}, train [0,{d['f_train_hi']}), holdout [{d['f_val_lo']},{n41})")
    extras = [load(n) for n in args.train_extra.split(',') if n]
    for d in extras:
        d['f_train_hi'] = d['F']; d['f_val_lo'] = d['F']; d['f_val_hi'] = d['F']; d['on'] = smear_onset(d['onset']); d['samp'] = args.extra_weight
    evals = [load(n) for n in args.eval_songs.split(',') if n]
    for d in evals: d['on'] = smear_onset(d['onset'])
    real_songs = songs; songs = songs + extras
    net = Net(parse_shifts(args.shifts), parse_arch(args.arch), args.norm)
    print(f"params {sum(p.numel() for p in net.parameters())} MACs/cell {net.macs}", flush=True)
    opt = torch.optim.Adam(net.parameters(), lr=args.lr)
    pos_w = torch.tensor([float(v) for v in args.pos_w.split(',')]).view(1, 2, 1, 1)
    T = {d['name']: dict(X=torch.from_numpy(d['X']), A=torch.from_numpy(d['active']), O=torch.from_numpy(d['on']), W=torch.from_numpy(d['weight'])) for d in songs}
    for d in songs:
        A = T[d['name']]['A']; M = torch.ones_like(A)
        if args.margin_w != 1.0:
            nb = torch.zeros_like(A); nb[:, 1:] = torch.maximum(nb[:, 1:], A[:, :-1]); nb[:, :-1] = torch.maximum(nb[:, :-1], A[:, 1:])
            M = torch.where((nb > 0) & (A == 0), torch.full_like(A, args.margin_w), M)
        if args.tail_frames > 0:
            off = torch.from_numpy(np.load(f"targets_{d['name']}.npz")['offset'].astype(np.float32))
            tail = torch.zeros_like(A)
            for k in range(args.tail_frames):
                tail[k:] = torch.maximum(tail[k:], off[: A.shape[0] - k])
            M = torch.where((tail > 0) & (A == 0), torch.full_like(A, args.tail_w), M)
        T[d['name']]['M'] = M
    total_train = sum(d['f_train_hi'] for d in songs)
    steps_per_epoch = max(1, total_train // (args.crop * args.batch) * args.steps_mult)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs * steps_per_epoch, eta_min=args.lr * 0.05)
    probs_song = np.array([d['f_train_hi'] * d['samp'] for d in songs], float); probs_song /= probs_song.sum()
    best = None; t_start = time.time()
    for ep in range(args.epochs):
        t = time.time(); tot = 0
        for _ in range(steps_per_epoch):
            xs, ys, ws, ms = [], [], [], []
            for _b in range(args.batch):
                d = songs[np.random.choice(len(songs), p=probs_song)]; s = np.random.randint(0, d['f_train_hi'] - args.crop); e = s + args.crop
                tt = T[d['name']]; xs.append(tt['X'][:, s:e]); ys.append(torch.stack([tt['A'][s:e], tt['O'][s:e]])); ws.append(tt['W'][s:e]); ms.append(tt['M'][s:e])
            x = torch.stack(xs); y = torch.stack(ys); w = torch.stack(ws); m = torch.stack(ms)
            if args.shift_aug > 0:
                k = int(np.random.randint(-args.shift_aug, args.shift_aug + 1))
                if k != 0:
                    x = torch.roll(x, k, dims=3); y = torch.roll(y, k, dims=3); m = torch.roll(m, k, dims=2)
                    if k > 0: x[..., :k] = -80.0; y[..., :k] = 0; m[..., :k] = 1
                    else: x[..., k:] = -80.0; y[..., k:] = 0; m[..., k:] = 1
            if args.gain_aug > 0: x = x + torch.empty(x.shape[0], 1, 1, 1).uniform_(-args.gain_aug, args.gain_aug)
            if args.noise_aug > 0: x = x + args.noise_aug * torch.randn_like(x)
            x = torch.clamp(x, -80, 0)
            loss = Fn.binary_cross_entropy_with_logits(net(x), y, pos_weight=pos_w, reduction='none')
            lw = torch.stack([m, torch.full_like(m, args.onset_w)], 1) * w[:, None, :, None]
            loss = (loss * lw).mean()
            opt.zero_grad(); loss.backward(); opt.step(); sched.step(); tot += loss.item()
        print(f"epoch {ep} loss {tot / steps_per_epoch:.4f} ({time.time() - t:.1f}s, total {(time.time() - t_start) / 60:.1f} min)", flush=True)
        if ep % args.eval_every == args.eval_every - 1 or ep == args.epochs - 1:
            vs = []
            for d in real_songs:
                prob = predict(net, d)
                evaluate(net, d, f"train-part {d['name']}", 0, d['f_train_hi'], prob)
                vs.append(evaluate(net, d, f"HOLDOUT {d['name']}", d['f_val_lo'], d['f_val_hi'], prob))
            for d in evals:
                vs.append(evaluate(net, d, f"UNSEEN {d['name']}", 0, d['F']))
            score = float(np.mean([v['nf1'] for v in vs]))
            print(f"  holdout mean note F1 {score:.3f}", flush=True)
            if best is None or score > best[0]: best = (score, ep, {k: v.clone() for k, v in net.state_dict().items()})
    print(f"best holdout mean note F1 {best[0]:.3f} at epoch {best[1]}")
    net.load_state_dict(best[2])
    cfg = dict(shifts=args.shifts, arch=args.arch, norm=args.norm)
    torch.save(dict(cfg=cfg, state=net.state_dict()), args.save); print("saved", args.save)
    if args.export:
        import decode_v2 as D
        dp = dict(D.DEFAULT); dp.update(json.loads(args.decode_params) if args.decode_params else {})
        export_json(net, args.export, args.version, dp)
