import numpy as np, json, sys
C1 = 32.7032; C4 = 261.6256; SR = 44100; HOP = 512
CFG = {
  'kipa': {'off': 0.9636, 'edo12_from': None, 'map': {
      'chords_41edo': (60, C4 * 2 ** (36/41), 41), 'bass_41edo': (60, C4 * 2 ** (36/41) / 4, 41)}},
  'xenprog': {'off': 0.4325, 'edo12_from': 174.375, 'map': {
      # structure_* はコード参照用で音は鳴っていない (map に無いトラックは教師にしない)
      'chords_41edo': (60, C4, 41), 'bass_41edo': (60, C4/4, 41),
      'chords_12edo': (60, C4, 12), 'bass_12edo': (60, C4/2, 12)}},
  # 2026-10-23 追加 (offset は onset 相互相関、基準は calibrate3/diffscan + alignment histogram で確認)
  'yxeni': {'off': 0.4354, 'edo12_from': None, 'map': {'chords_41edo': (60, C4, 41), 'bass_41edo': (60, C4 / 4, 41)}},
  'mafle': {'off': 0.238, 'edo12_from': None, 'map': {
      'chords_low_41edo': (60, C4, 41), 'chords_high_41edo': (60, C4 * 4, 41), 'bass_41edo': (60, C4 / 4, 41)}},
  'fnas': {'off': 0.4992, 'edo12_from': None, 'map': {'chords_41edo': (60, C4, 41), 'bass_41edo': (60, C4 / 2, 41)}},
}
P = 287
def build(name):
    cfg = CFG[name]; meta = json.load(open(f"feat_{name}_meta.json")); F = meta['frames']
    notes = json.load(open(f"{name}_notes.json"))
    active = np.zeros((F, P), np.uint8); onset = np.zeros((F, P), np.uint8); offset_ = np.zeros((F, P), np.uint8)
    weight = np.ones(F, np.float32)
    fps = SR / HOP
    if cfg['edo12_from'] is not None:
        weight[int((cfg['edo12_from'] + cfg['off']) * fps):] = 0
    rows = []
    for n in notes:
        if n['track'] not in cfg['map']: continue
        base, hz, spo = cfg['map'][n['track']]
        f = hz * 2 ** ((n['note'] - base) / spo)
        pf = 41 * np.log2(f / C1)
        p = int(round(pf))
        if spo == 41: assert abs(pf - p) < 1e-6, (n, pf)
        if not (0 <= p < P): continue
        a = int(round((n['t0'] + cfg['off']) * fps)); b = int(round((n['t1'] + cfg['off']) * fps))
        b = max(b, a + 1)
        if a >= F: continue
        active[a:min(b, F), p] = 1; onset[a, p] = 1
        if b < F: offset_[b, p] = 1
        rows.append((n['t0'] + cfg['off'], n['t1'] + cfg['off'], p, n['track'], pf))
    np.savez_compressed(f"targets_{name}.npz", active=active, onset=onset, offset=offset_, weight=weight,
                        notes=np.array([(r[0], r[1], r[2]) for r in rows], np.float64),
                        note_tracks=np.array([r[3] for r in rows]), note_pf=np.array([r[4] for r in rows]))
    print(f"[{name}] frames={F} notes={len(rows)} active cells={active.sum()} 41edo frames={int(weight.sum())} steps range {min(r[2] for r in rows)}..{max(r[2] for r in rows)}")
    return active, weight, rows, meta
def alignment_check(name, active, weight, rows, meta):
    # for each 41edo note: argmax offset of h=1 plane within ±3 bins over the note's middle frames
    F = meta['frames']
    planes = {h: np.fromfile(f"feat_{name}_h{h}.u8", np.uint8).reshape(F, P) for h in (1, 2, 3)}
    fps = SR / HOP
    for tr in sorted(set(r[3] for r in rows)):
        hist = {h: np.zeros(7, int) for h in planes}
        for t0, t1, p, track, pf in rows:
            if track != tr or p < 3 or p >= P - 3: continue
            a = int(t0 * fps) + 2; b = max(a + 1, int(t1 * fps) - 1)
            if b > F: continue
            for h, pl in planes.items():
                seg = pl[a:b, p-3:p+4].astype(float).mean(axis=0)
                hist[h][int(np.argmax(seg))] += 1
        print(f"  [{name}] {tr}: argmax offset histogram (-3..+3) h1={hist[1].tolist()} h2={hist[2].tolist()} h3={hist[3].tolist()}")
if __name__ == '__main__':
    for name in sys.argv[1:]:
        active, weight, rows, meta = build(name)
        alignment_check(name, active, weight, rows, meta)
