# MIDI -> list of notes (t0_sec, t1_sec, track_name, note, vel, bends[(t_sec, value)])
import struct, json, sys

def read_vlq(data, i):
    v = 0
    while True:
        b = data[i]; i += 1
        v = (v << 7) | (b & 0x7f)
        if not (b & 0x80): return v, i

def parse(path):
    data = open(path, 'rb').read()
    hlen = struct.unpack('>I', data[4:8])[0]
    fmt, ntracks, division = struct.unpack('>HHH', data[8:14])
    i = 8 + hlen
    tracks = []
    for t in range(ntracks):
        tlen = struct.unpack('>I', data[i+4:i+8])[0]
        j = i + 8; end = j + tlen
        tick = 0; status = None; events = []
        while j < end:
            dt, j = read_vlq(data, j); tick += dt
            b = data[j]
            if b == 0xff:
                typ = data[j+1]; ln, j2 = read_vlq(data, j+2)
                events.append((tick, 'meta', typ, data[j2:j2+ln])); j = j2 + ln
            elif b in (0xf0, 0xf7):
                ln, j2 = read_vlq(data, j+1); j = j2 + ln
            else:
                if b & 0x80: status = b; j += 1
                kind = status & 0xf0; ch = status & 0x0f
                if kind in (0xc0, 0xd0):
                    events.append((tick, kind, ch, data[j], None)); j += 1
                else:
                    events.append((tick, kind, ch, data[j], data[j+1])); j += 2
        tracks.append(events); i = end
    return fmt, division, tracks

def load_notes(path):
    fmt, division, tracks = parse(path)
    tempos = sorted((e[0], int.from_bytes(e[3], 'big')) for ev in tracks for e in ev if e[1]=='meta' and e[2]==0x51)
    if not tempos or tempos[0][0] != 0: tempos.insert(0, (0, 500000))
    def tick2sec(tick):
        sec = 0.0; last = 0; us = tempos[0][1]
        for tt, tus in tempos:
            if tt >= tick: break
            sec += (tt - last) * us / division / 1e6; last = tt; us = tus
        return sec + (tick - last) * us / division / 1e6
    out = []
    for ti, events in enumerate(tracks):
        name = next((e[3].decode('latin1') for e in events if e[1]=='meta' and e[2]==3), f"track{ti}")
        on = {}; bends = []
        for e in events:
            if e[1] == 'meta': continue
            kind = e[1]
            if kind == 0x90 and e[4] > 0:
                on.setdefault(e[3], []).append((e[0], e[4]))
            elif kind == 0x80 or (kind == 0x90 and e[4] == 0):
                lst = on.get(e[3])
                if lst:
                    t0, vel = lst.pop(0)
                    out.append(dict(t0=tick2sec(t0), t1=tick2sec(e[0]), track=name, ti=ti, note=e[3], vel=vel))
            elif kind == 0xe0:
                bends.append((tick2sec(e[0]), (e[4] << 7 | e[3]) - 8192))
        if bends:
            for n in out:
                if n['ti'] == ti:
                    n['bends'] = [(round(t,4), v) for t, v in bends if n['t0'] - 1e-6 <= t <= n['t1'] + 1e-6]
    out.sort(key=lambda n: (n['t0'], n['note']))
    return out

if __name__ == '__main__':
    notes = load_notes(sys.argv[1])
    json.dump(notes, open(sys.argv[2], 'w'))
    print(len(notes), "notes ->", sys.argv[2])
