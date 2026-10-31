# timbre 方向の実験用コピー (train_exp.py + model-based 2-pass templates / harmonic NMF channel): train_final.py の学習ループに (A) 再構成ロス (analysis-by-synthesis)、(B) 聴覚的 front-end channel、
# (C) 曲ごとの音色テンプレート channel、(U) 教師なし曲 (再構成ロスのみ) を足したもの。ステップ数固定で比較する
import numpy as np, json, sys, re, argparse, time, torch, torch.nn as nn, torch.nn.functional as Fn, collections
from netlib import P, SR, HOP, FPS, HARM, load, smear_onset, parse_shifts, parse_arch, predict, note_metrics, evaluate, export_json
import netlib
ap = argparse.ArgumentParser()
ap.add_argument('--songs', default='kipa,xenprog,yxeni,fnas'); ap.add_argument('--train_extra', default='')
ap.add_argument('--eval_songs', default='mafle'); ap.add_argument('--unsup', default='', help='comma list of pieces with no labels (recon loss only)')
ap.add_argument('--holdout', type=float, default=0.2)
ap.add_argument('--max_steps', type=int, default=4000); ap.add_argument('--eval_every_steps', type=int, default=1000)
ap.add_argument('--lr', type=float, default=2e-3); ap.add_argument('--crop', type=int, default=256); ap.add_argument('--batch', type=int, default=8)
ap.add_argument('--save', default=''); ap.add_argument('--export', default=''); ap.add_argument('--version', default='edo41-cnn-exp')
ap.add_argument('--seed', type=int, default=0); ap.add_argument('--threads', type=int, default=4)
ap.add_argument('--gain_aug', type=float, default=12.0); ap.add_argument('--noise_aug', type=float, default=1.0); ap.add_argument('--shift_aug', type=int, default=8)
ap.add_argument('--shifts', default='1:-41,1:-65,1:-82'); ap.add_argument('--norm', default='none')
ap.add_argument('--arch', default='24x3x9,24x1x15,16x5x1t2,16x5x1t4,16x3x3')
ap.add_argument('--pos_w', default='1,10'); ap.add_argument('--onset_w', type=float, default=1.0)
ap.add_argument('--init', default='', help='初期重み: note-model.json か .pt')
# (A) reconstruction
ap.add_argument('--recon', type=float, default=0.0, help='再構成ロスの重み (0 で無効)')
ap.add_argument('--recon_k', type=int, default=8, help='再構成に使う倍音数')
ap.add_argument('--recon_planes', default='1', help='再構成対象 plane (comma, 例 1,2)')
ap.add_argument('--recon_sparse', type=float, default=0.0, help='amp の L1 ペナルティ')
ap.add_argument('--recon_gate', type=float, default=0.0, help='amp を sigmoid(active) で gate する (1) / しない (0)')
# (B) auditory front-end channels
ap.add_argument('--front', default='', help='comma: aw (A-weighting), lcn (octave 幅の局所コントラスト), adapt (時間順応 x-EMA), pow (べき圧縮)')
ap.add_argument('--front_tau', type=float, default=8.0, help='adapt の EMA 時定数 (frame)')
# (C) per-song timbre templates (oracle: GT ノートの倍音プロファイルを k-means)
ap.add_argument('--templates', type=int, default=0, help='曲ごとのテンプレート数 K (0 で無効)')
ap.add_argument('--templates_from', default='gt', help='gt | model:<pt or json> (2 パス)')
ap.add_argument('--decode_params', default='')
ap.add_argument('--tmpl_stat', default='mean', help='profile statistic per note: mean | median | trim (20pct trimmed mean)')
ap.add_argument('--tmpl_mode', default='dot', help='dot (train_exp と同じ内積) | dist (負の二乗距離, plane1 でゲート)')
ap.add_argument('--nmf_iters', type=int, default=60); ap.add_argument('--nmf_k', type=int, default=8)
ap.add_argument('--tmpl_dump', type=int, default=1)
args = ap.parse_args()
torch.set_num_threads(args.threads); torch.manual_seed(args.seed); np.random.seed(args.seed)
if args.decode_params: netlib.DECODE_OVERRIDE = json.loads(args.decode_params)

FRONT = [f for f in args.front.split(',') if f]
HARM_OFF = [int(round(41 * np.log2(k))) for k in range(1, args.recon_k + 1)]

# ---------------- front-end channels (B) ----------------
def a_weight_db(freq):
    f2 = freq ** 2
    ra = 12194 ** 2 * f2 ** 2 / ((f2 + 20.6 ** 2) * np.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2))
    return 20 * np.log10(ra) + 2.0
BIN_HZ = 32.7032 * 2 ** (np.arange(P) / 41)
AW = torch.tensor(a_weight_db(BIN_HZ) / 40.0, dtype=torch.float32)  # normalized units (dB/40)

def front_channels(x, planes_norm):
    """x: (B,7,T,P) normalized dB. returns list of extra (B,c,T,P) tensors"""
    out = []
    if 'aw' in FRONT:
        out.append(planes_norm[:, 0:1] + AW.view(1, 1, 1, P))
    if 'lcn' in FRONT:
        k = 41; pad = k // 2
        for hi in range(planes_norm.shape[1]):
            pl = planes_norm[:, hi:hi + 1]
            ma = Fn.avg_pool2d(Fn.pad(pl, (pad, pad, 0, 0), mode='replicate'), (1, k), stride=1)
            out.append(pl - ma)
    if 'adapt' in FRONT:
        # 時間順応: x - EMA(x) (τ frame)。因果 EMA を再帰で計算 (crop 単位)
        a = 1.0 / args.front_tau
        pl = planes_norm[:, 0]
        ema = torch.zeros_like(pl); prev = pl[:, 0]
        emas = []
        for t in range(pl.shape[1]):
            prev = prev + a * (pl[:, t] - prev); emas.append(prev)
        ema = torch.stack(emas, 1)
        out.append((pl - ema)[:, None] * 3.0)
    if 'pow' in FRONT:
        # dB → 線形振幅^0.3 (Stevens の音の大きさ則に近い圧縮)
        lin = 10 ** ((planes_norm * 40.0 - 40.0) / 20.0)
        out.append((lin ** 0.3 * 2.0 - 1.0)[:, 0:1])
    return out

def n_front_channels():
    n = 0
    if 'aw' in FRONT: n += 1
    if 'lcn' in FRONT: n += len(HARM)
    if 'adapt' in FRONT: n += 1
    if 'pow' in FRONT: n += 1
    return n

# ---------------- model ----------------
class ExpNet(nn.Module):
    def __init__(self, shifts, arch, norm, n_templates, recon_k):
        super().__init__()
        self.shifts = shifts; self.norm = norm; self.n_templates = n_templates
        cin = len(HARM) + len(shifts) + n_front_channels() + n_templates
        mods = []; macs = 0
        for c, kt, kp, dt, dp in arch:
            mods += [nn.Conv2d(cin, c, (kt, kp), padding=(dt * (kt // 2), dp * (kp // 2)), dilation=(dt, dp)), nn.ReLU()]
            macs += cin * c * kt * kp; cin = c
        self.trunk = nn.Sequential(*mods); self.ctrunk = cin
        self.head = nn.Conv2d(cin, 2, 1)
        with torch.no_grad(): self.head.bias.copy_(torch.tensor([-3.0, -5.0]))
        self.amp = nn.Conv2d(cin, recon_k, 1) if args.recon > 0 else None
        self.macs = macs + cin * 2
    def features(self, x, tmpl=None):
        xn = (x + 40.0) / 40.0
        chans = [xn]
        for hi, sh in self.shifts:
            pl = xn[:, hi]; z = torch.full_like(pl, -1.0)
            if sh < 0: z[:, :, -sh:] = pl[:, :, :sh]
            elif sh > 0: z[:, :, :-sh] = pl[:, :, sh:]
            else: z = pl
            chans.append(z[:, None])
        chans += front_channels(x, xn)
        if self.n_templates: chans.append(tmpl)
        f = torch.cat(chans, 1)
        if self.norm == 'frame': f = f - xn[:, 0:1].amax(dim=3, keepdim=True)
        return f
    def forward(self, x, tmpl=None):
        h = self.trunk(self.features(x, tmpl))
        logits = self.head(h)
        amp = Fn.softplus(self.amp(h)) if self.amp is not None else None
        return logits, amp
    # 書き出し用: trunk + head だけの Sequential (conv-net.ts 互換)
    def export_seq(self):
        return nn.Sequential(*list(self.trunk), self.head)

def recon_spectrum(amp, logits):
    """amp: (B,K,T,P) 各 pitch の倍音振幅 → plane h=1 の線形振幅予測 (B,T,P)"""
    if args.recon_gate > 0: amp = amp * torch.sigmoid(logits[:, 0:1])
    S = torch.zeros_like(amp[:, 0])
    for k, off in enumerate(HARM_OFF):
        if off == 0: S = S + amp[:, k]
        else: S[:, :, off:] = S[:, :, off:] + amp[:, k][:, :, :-off]
    return S

def recon_loss(amp, logits, x):
    # 観測: dB → 線形相対振幅 (0..1)、log1p 領域で比較
    S = recon_spectrum(amp, logits)
    T = 10 ** (x[:, 0] / 20.0)
    c = 20.0
    l = Fn.mse_loss(torch.log1p(c * S), torch.log1p(c * T))
    if args.recon_sparse > 0: l = l + args.recon_sparse * amp.mean()
    return l

# ---------------- per-song templates (C) ----------------
NMF_OFF = [int(round(41 * np.log2(k))) for k in range(1, 9)]  # 0,41,65,82,95,106,115,123
def note_profiles(d, notes, stat):
    X = d['X']; F = d['F']; prof = []
    for t0, t1, p in notes:
        a = int(round(t0 * FPS)) + 2; b = max(a + 1, int(round(t1 * FPS)) - 1); p = int(p)
        if b > F or p >= P: continue
        seg = X[:, a:b, p]
        if stat == 'median': v = np.median(seg, 1)
        elif stat == 'trim':
            s = np.sort(seg, 1); n = s.shape[1]; k = int(n * 0.2); v = s[:, k:max(k + 1, n - k)].mean(1)
        else: v = seg.mean(1)
        prof.append(v)
    prof = np.array(prof); prof = (prof + 40.0) / 40.0
    return prof - prof[:, :1]
def kmeans(prof, K):
    # app/lib/note-templates.ts の kmeansProfiles と同一 (初期化・出力順)。pass 2 は channel 順に依存する
    order = np.argsort(prof.sum(1), kind='stable')
    C = prof[order[((np.arange(K) + 0.5) * len(prof) / K).astype(int)]].astype(np.float64).copy()
    for _ in range(30):
        lab = ((prof[:, None, :] - C[None]) ** 2).sum(-1).argmin(1)
        for k in range(K):
            if (lab == k).any(): C[k] = prof[lab == k].mean(0)
    s = np.argsort(C.sum(1), kind='stable'); remap = np.argsort(s)
    return C[s].astype(np.float32), remap[lab]
_PASS1 = {}
def pass1_notes(d, path):
    if 'net' not in _PASS1:
        if path.endswith('.json'):
            from json_to_pt import load_json_model
            _PASS1['net'], _ = load_json_model(path)
        else:
            sd = torch.load(path); a = sd['args']
            m = ExpNet(parse_shifts(a['shifts']), parse_arch(a['arch']), a['norm'], 0, a.get('recon_k', 8)); m.load_state_dict(sd['state']); _PASS1['net'] = m
    m = _PASS1['net']; m.eval()
    with torch.no_grad():
        x = torch.from_numpy(d['X'])[None]; outs = []
        for s in range(0, d['F'], 2048):
            o = m(x[:, :, s:min(s + 2048, d['F'])]); outs.append(o[0] if isinstance(o, tuple) else o)
        prob = torch.sigmoid(torch.cat(outs, 2))[0].numpy()
    return netlib.decode(prob)
def song_templates(d, K, source):
    """各ノートの中央 frame での 7 plane プロファイル (正規化 dB, 基音相対) を k-means → (K,7)"""
    if source == 'gt': notes = [tuple(n) for n in d['notes']]
    elif source.startswith('model:'): notes = pass1_notes(d, source[6:])
    else: raise ValueError(source)
    prof = note_profiles(d, notes, args.tmpl_stat)
    if len(prof) < K: prof = np.concatenate([prof, np.zeros((K - len(prof), len(HARM)), np.float32)])
    C, lab = kmeans(prof, K)
    if args.tmpl_dump:
        print(f"  templates {d['name']} ({source}, {len(prof)} notes): " + " | ".join(f"c{k} n={int((lab == k).sum())} {np.round(C[k][1:] * 40).astype(int).tolist()}dB" for k in range(K)), flush=True)
    return C
def template_channels(d, C):
    Xn = (d['X'] + 40.0) / 40.0; rel = Xn - Xn[0:1]
    out = np.zeros((C.shape[0], d['F'], P), np.float32)
    for k in range(C.shape[0]):
        if args.tmpl_mode == 'dist':
            # 平面1 の音量でゲートした負の距離: 無音・倍音位置で 0 付近、テンプレート一致で高い
            d2 = ((rel - C[k][:, None, None]) ** 2).sum(0)
            out[k] = (1.0 - d2) * np.clip(Xn[0] + 1.0, 0, 2) * 0.5
        else:
            w = C[k] / (np.linalg.norm(C[k]) + 1e-6)
            out[k] = np.tensordot(w, rel, axes=(0, 0))
    return out
def nmf_channels(d, K):
    """shift-invariant harmonic NMF (KL, 乗法更新) on linear h=1 plane → K activation channels (dB 正規化)"""
    import os
    cache = f"nmf_timbre_K{K}_J{args.nmf_k}_it{args.nmf_iters}_{d['name']}.npy"
    if os.path.exists(cache): return np.load(cache)
    out = _nmf_channels(d, K); np.save(cache, out); return out
def _nmf_channels(d, K):
    V = 10 ** (d['X'][0] / 20.0); V = V / V.max(); F = d['F']; rng = np.random.default_rng(0)
    J = args.nmf_k; off = NMF_OFF[:J]
    W = np.exp(-rng.uniform(0.2, 1.2, (K, 1)) * np.arange(J)[None]) * rng.uniform(0.5, 1.5, (K, J)); W[:, 0] = 1.0
    H = np.maximum(V[None] * rng.uniform(0.5, 1.0, (K, F, P)), 1e-6)
    def shift(A, o):  # A[f,p] -> B[f,p+o]
        B = np.zeros_like(A)
        if o == 0: return A.copy()
        B[:, o:] = A[:, :-o]; return B
    def unshift(A, o):
        B = np.zeros_like(A)
        if o == 0: return A.copy()
        B[:, :-o] = A[:, o:]; return B
    ones = np.ones_like(V)
    for it in range(args.nmf_iters):
        Vh = sum(W[k, j] * shift(H[k], off[j]) for k in range(K) for j in range(J)) + 1e-6
        R = V / Vh
        for k in range(K):
            num = sum(W[k, j] * unshift(R, off[j]) for j in range(J)); den = sum(W[k, j] * unshift(ones, off[j]) for j in range(J)) + 1e-6
            H[k] *= num / den
        Vh = sum(W[k, j] * shift(H[k], off[j]) for k in range(K) for j in range(J)) + 1e-6
        R = V / Vh
        for k in range(K):
            for j in range(1, J):
                sh = shift(H[k], off[j]); W[k, j] *= (R * sh).sum() / (sh.sum() + 1e-9)
        W = np.clip(W, 1e-4, 4.0)
    if args.tmpl_dump:
        print(f"  nmf {d['name']}: " + " | ".join(f"c{k} {np.round(20 * np.log10(W[k])).astype(int).tolist()}dB act={H[k].mean():.4f}" for k in range(K)), flush=True)
    out = np.zeros((K, F, P), np.float32)
    for k in range(K):
        db = 20 * np.log10(np.maximum(H[k] * W[k].sum(), 1e-4))  # 0 dB = 曲中最大
        out[k] = np.clip((db + 40.0) / 40.0, -1.0, 1.0)
    return out

# ---------------- data ----------------
def prep(name, labeled=True):
    d = load(name); d['on'] = smear_onset(d['onset']); d['labeled'] = labeled
    return d
songs = [prep(n) for n in args.songs.split(',') if n]
for d in songs:
    n41 = int((d['weight'] > 0).sum()); d['f_train_hi'] = int(n41 * (1 - args.holdout)); d['f_val_lo'] = d['f_train_hi']; d['f_val_hi'] = n41; d['samp'] = 1.0
extras = [prep(n) for n in args.train_extra.split(',') if n]
for d in extras: d['f_train_hi'] = d['F']; d['samp'] = 1.0
unsup = [prep(n, labeled=False) for n in args.unsup.split(',') if n]
for d in unsup: d['f_train_hi'] = d['F']; d['samp'] = 1.0
evals = [prep(n) for n in args.eval_songs.split(',') if n]
train_pool = songs + extras + unsup
if args.templates:
    for d in train_pool + evals:
        if args.templates_from == 'nmf': d['tmpl'] = nmf_channels(d, args.templates)
        elif args.templates_from.startswith('model:'): d['tmpl'] = template_channels(d, song_templates(d, args.templates, args.templates_from))
        elif d['labeled']: d['tmpl'] = template_channels(d, song_templates(d, args.templates, 'gt'))
        else: d['tmpl'] = np.zeros((args.templates, d['F'], P), np.float32)
    for d in train_pool + evals:
        tm = d['tmpl']; act = d['active'] > 0
        if act.any(): print(f"  tmpl-ch {d['name']}: mean/std={tm.mean():.2f}/{tm.std():.2f} active={tm[:, act].mean():.2f} inactive={tm[:, ~act].mean():.2f}", flush=True)

net = ExpNet(parse_shifts(args.shifts), parse_arch(args.arch), args.norm, args.templates, args.recon_k)
if args.init:
    if args.init.endswith('.json'):
        from json_to_pt import load_json_model
        src, _ = load_json_model(args.init)
        convs_src = [m for m in src.net if isinstance(m, nn.Conv2d)]; convs_dst = [m for m in net.trunk if isinstance(m, nn.Conv2d)] + [net.head]
        with torch.no_grad():
            for a, b in zip(convs_src, convs_dst):
                if a.weight.shape == b.weight.shape: b.weight.copy_(a.weight); b.bias.copy_(a.bias)
                else:
                    ci = min(a.weight.shape[1], b.weight.shape[1]); b.weight[:, :ci].copy_(a.weight[:, :ci]); b.bias.copy_(a.bias)
        print("initialized from", args.init)
print(f"params {sum(p.numel() for p in net.parameters())} MACs/cell(export) {net.macs} in_ch {len(HARM) + len(net.shifts) + n_front_channels() + args.templates} front={FRONT} recon={args.recon} templates={args.templates}", flush=True)
opt = torch.optim.Adam(net.parameters(), lr=args.lr)
sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.max_steps, eta_min=args.lr * 0.05)
pos_w = torch.tensor([float(v) for v in args.pos_w.split(',')]).view(1, 2, 1, 1)
T = {}
for d in train_pool:
    T[d['name']] = dict(X=torch.from_numpy(d['X']), A=torch.from_numpy(d['active']), O=torch.from_numpy(d['on']), W=torch.from_numpy(d['weight']),
                        TM=torch.from_numpy(d['tmpl']) if args.templates else None)
probs = np.array([d['f_train_hi'] * d['samp'] for d in train_pool], float); probs /= probs.sum()

def run_eval(net, step):
    def predict_exp(d):
        net.eval()
        with torch.no_grad():
            x = torch.from_numpy(d['X'])[None]; tm = torch.from_numpy(d['tmpl'])[None] if args.templates else None
            outs = []
            for s in range(0, d['F'], 2048):
                e = min(s + 2048, d['F'])
                lg, _ = net(x[:, :, s:e], tm[:, :, s:e] if tm is not None else None); outs.append(lg)
            prob = torch.sigmoid(torch.cat(outs, 2))[0].numpy()
        net.train(); return prob
    vs = []; res = {}
    for d in songs:
        prob = predict_exp(d)
        evaluate(net, d, f"step{step} train-part {d['name']}", 0, d['f_train_hi'], prob)
        r = evaluate(net, d, f"step{step} HOLDOUT {d['name']}", d['f_val_lo'], d['f_val_hi'], prob); vs.append(r['nf1']); res[f"holdout_{d['name']}"] = r['nf1']
    us = []
    for d in evals:
        r = evaluate(net, d, f"step{step} UNSEEN {d['name']}", 0, d['F'], predict_exp(d)); us.append(r['nf1']); res[f"unseen_{d['name']}"] = r['nf1']
    res['holdout_mean'] = float(np.mean(vs)) if vs else 0.0; res['unseen_mean'] = float(np.mean(us)) if us else 0.0
    print(f"  == step {step}: holdout mean {res['holdout_mean']:.3f}, unseen mean {res['unseen_mean']:.3f}", flush=True)
    return res

best = None; t0 = time.time(); hist = []
for step in range(1, args.max_steps + 1):
    xs, ys, ws, ms, tms, lbl = [], [], [], [], [], []
    for _ in range(args.batch):
        d = train_pool[np.random.choice(len(train_pool), p=probs)]; s = np.random.randint(0, d['f_train_hi'] - args.crop); e = s + args.crop
        tt = T[d['name']]; xs.append(tt['X'][:, s:e]); ys.append(torch.stack([tt['A'][s:e], tt['O'][s:e]])); ws.append(tt['W'][s:e] * (1.0 if d['labeled'] else 0.0))
        tms.append(tt['TM'][:, s:e] if args.templates else torch.zeros(1))
    x = torch.stack(xs); y = torch.stack(ys); w = torch.stack(ws); tm = torch.stack(tms) if args.templates else None
    if args.shift_aug > 0:
        k = int(np.random.randint(-args.shift_aug, args.shift_aug + 1))
        if k != 0:
            x = torch.roll(x, k, dims=3); y = torch.roll(y, k, dims=3)
            if tm is not None: tm = torch.roll(tm, k, dims=3)
            if k > 0: x[..., :k] = -80.0; y[..., :k] = 0
            else: x[..., k:] = -80.0; y[..., k:] = 0
    if args.gain_aug > 0: x = x + torch.empty(x.shape[0], 1, 1, 1).uniform_(-args.gain_aug, args.gain_aug)
    if args.noise_aug > 0: x = x + args.noise_aug * torch.randn_like(x)
    x = torch.clamp(x, -80, 0)
    logits, amp = net(x, tm)
    bce = Fn.binary_cross_entropy_with_logits(logits, y, pos_weight=pos_w, reduction='none')
    lw = torch.stack([torch.ones_like(w), torch.full_like(w, args.onset_w)], 1)[:, :, :, None] * w[:, None, :, None]
    loss = (bce * lw).sum() / (lw.sum() * P + 1e-6)
    if args.recon > 0: loss = loss + args.recon * recon_loss(amp, logits, x)
    opt.zero_grad(); loss.backward(); opt.step(); sched.step()
    if step % 100 == 0: print(f"step {step} loss {loss.item():.4f} ({(time.time() - t0) / 60:.1f} min)", flush=True)
    if step % args.eval_every_steps == 0 or step == args.max_steps:
        res = run_eval(net, step); hist.append((step, res))
        score = res['holdout_mean']
        if best is None or score > best[0]: best = (score, step, {k: v.clone() for k, v in net.state_dict().items()}, res)
print(f"BEST holdout mean {best[0]:.3f} at step {best[1]} :: " + json.dumps({k: round(v, 3) for k, v in best[3].items()}))
net.load_state_dict(best[2])
if args.save: torch.save(dict(args=vars(args), state=net.state_dict()), args.save); print("saved", args.save)
if args.export:
    import decode_v2 as D
    dp = dict(D.DEFAULT); dp.update(netlib.DECODE_OVERRIDE)
    seq = net.export_seq()
    class W: pass
    wnet = W(); wnet.net = seq; wnet.shifts = net.shifts; wnet.norm = net.norm; wnet.macs = net.macs
    export_json(wnet, args.export, args.version, dp)
