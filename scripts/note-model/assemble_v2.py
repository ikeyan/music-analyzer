# pass2 の export JSON + pass1 (現行モデル) → アプリ用 2 パス JSON
import json, sys
pass2 = json.load(open(sys.argv[1])); pass1 = json.load(open(sys.argv[2])); out = sys.argv[3]; k = int(sys.argv[4])
pass1.pop("version", None); pass1.pop("pass1", None)
doc = dict(pass2); doc["input"] = dict(pass2["input"]); doc["input"]["templates"] = k
doc["input"].pop("norm", None) if doc["input"].get("norm") == "none" else None
doc["pass1"] = pass1
assert doc["layers"][0]["in"] == len(doc["input"]["harmonics"]) + len(doc["input"]["shifts"]) + k, doc["layers"][0]["in"]
json.dump(doc, open(out, "w"), separators=(",", ":"))
print("assembled", out, "pass2 in_ch", doc["layers"][0]["in"], "version", doc["version"])
