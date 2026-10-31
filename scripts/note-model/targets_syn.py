import numpy as np, json, sys, os, time
SR, HOP, P = 44100, 512, 287
for name in sys.argv[1:]:
    while not os.path.exists(f"feat_{name}_meta.json"): time.sleep(2)
    F = json.load(open(f"feat_{name}_meta.json"))['frames']; notes = json.load(open(f"{name}_notes.json"))
    active = np.zeros((F, P), np.uint8); onset = np.zeros((F, P), np.uint8); offset_ = np.zeros((F, P), np.uint8)
    fps = SR / HOP; rows = []
    for t0, t1, s in notes:
        p = s - 41
        if not (0 <= p < P): continue
        a = int(round(t0 * fps)); b = max(int(round(t1 * fps)), a + 1)
        if a >= F: continue
        active[a:min(b, F), p] = 1; onset[a, p] = 1
        if b < F: offset_[b, p] = 1
        rows.append((t0, t1, p))
    np.savez_compressed(f"targets_{name}.npz", active=active, onset=onset, offset=offset_, weight=np.ones(F, np.float32),
                        notes=np.array(rows, np.float64), note_tracks=np.array(['syn'] * len(rows)), note_pf=np.array([r[2] for r in rows], float))
    print(name, "frames", F, "notes", len(rows))
