# app/lib/note-model.json → netlib.Net (学習側で再評価・継続学習するため)
import json, sys, torch, numpy as np
from netlib import Net, parse_arch, parse_shifts, HARM
def load_json_model(path):
    d = json.load(open(path))
    shifts = ",".join(f"{s['harmonic']}:{s['bins']}" for s in d['input']['shifts'])
    arch = ",".join(f"{l['out']}x{l['kt']}x{l['kb']}" + (f"t{l['dt']}" if l.get('dt', 1) != 1 else "") + (f"b{l['db']}" if l.get('db', 1) != 1 else "") for l in d['layers'][:-1])
    net = Net(parse_shifts(shifts), parse_arch(arch), d['input'].get('norm', 'none'))
    convs = [m for m in net.net if isinstance(m, torch.nn.Conv2d)]
    assert len(convs) == len(d['layers'])
    with torch.no_grad():
        for m, l in zip(convs, d['layers']):
            m.weight.copy_(torch.tensor(l['w'], dtype=torch.float32).reshape(m.weight.shape)); m.bias.copy_(torch.tensor(l['b'], dtype=torch.float32))
    return net, d
if __name__ == '__main__':
    net, d = load_json_model(sys.argv[1]); torch.save(dict(cfg=dict(shifts=d['input']['shifts'], arch='json', norm=d['input'].get('norm','none')), state=net.state_dict()), sys.argv[2]); print("saved", sys.argv[2], "version", d['version'])
