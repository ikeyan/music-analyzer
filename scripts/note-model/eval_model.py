# 保存モデル (note-model.json / train_exp の .pt) を曲ごとに評価 (全曲 or 末尾 holdout)
import sys, json, torch, numpy as np
from netlib import load, smear_onset, evaluate, FPS
import netlib
def predict_any(net, d, tmpl=None):
    net.eval()
    with torch.no_grad():
        x = torch.from_numpy(d['X'])[None]; outs = []
        for s in range(0, d['F'], 2048):
            e = min(s + 2048, d['F'])
            o = net(x[:, :, s:e]) if tmpl is None else net(x[:, :, s:e], tmpl[:, :, s:e])
            outs.append(o[0] if isinstance(o, tuple) else o)
        prob = torch.sigmoid(torch.cat(outs, 2))[0].numpy()
    return prob
if __name__ == '__main__':
    path = sys.argv[1]; songs = sys.argv[2].split(','); mode = sys.argv[3] if len(sys.argv) > 3 else 'full'
    if path.endswith('.json'):
        from json_to_pt import load_json_model
        net, _ = load_json_model(path)
    else:
        raise SystemExit("use train_exp --save and evaluate inside train_exp for ExpNet")
    for name in songs:
        d = load(name); d['on'] = smear_onset(d['onset'])
        n41 = int((d['weight'] > 0).sum())
        prob = predict_any(net, d)
        if mode == 'full': evaluate(net, d, f"{name} FULL", 0, d['F'], prob)
        else:
            evaluate(net, d, f"{name} train-part", 0, int(n41 * 0.8), prob); evaluate(net, d, f"{name} HOLDOUT", int(n41 * 0.8), n41, prob)
