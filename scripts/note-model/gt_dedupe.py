import numpy as np
def dedupe_gt(rows, onset_tol=0.05):
    """rows: iterable of (t0, t1, bin, ...) sorted or not. Merge same-bin notes whose onsets are within onset_tol; keep the longer end."""
    rows = sorted(rows, key=lambda r: (int(r[2]), r[0]))
    out = []
    for r in rows:
        if out and int(out[-1][2]) == int(r[2]) and r[0] - out[-1][0] <= onset_tol:
            prev = out[-1]
            out[-1] = (prev[0], max(prev[1], r[1]), prev[2]) + tuple(prev[3:])
        else:
            out.append(tuple(r))
    out.sort(key=lambda r: (r[0], int(r[2])))
    return out
