#!/usr/bin/env python3
"""Create the pinned full-coverage normal face, using fonttools==4.60.1.

The upstream variable font defaults to Thin (100). The sfnt-unhinted-v1
contract renders a default face, so instantiate 400 once at build time rather
than silently selecting different variation axes in the native and web hosts.
"""
import argparse, hashlib, json
from pathlib import Path
import fontTools
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
assert fontTools.__version__ == "4.60.1", "Use the reviewed fonttools==4.60.1"
source = args.source.read_bytes()
assert hashlib.sha256(source).hexdigest() == "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da"
assert not args.output.exists(), "Use a fresh output"
font = TTFont(args.source, recalcTimestamp=False)
coverage = set(font.getBestCmap())
assert [(a.axisTag, a.defaultValue) for a in font["fvar"].axes] == [("wght", 100)]
font = instantiateVariableFont(font, {"wght": 400}, inplace=True, updateFontNames=True)
assert "fvar" not in font and set(font.getBestCmap()) == coverage
# Give this modified face its own family name, retaining license/copyright.
for record in font["name"].names:
    names = {1: "Container Sans SC", 2: "Regular", 3: "Container Sans SC Regular 1.0", 4: "Container Sans SC Regular", 6: "ContainerSansSC-Regular", 16: "Container Sans SC", 17: "Regular"}
    if record.nameID in names:
        record.string = names[record.nameID].encode(record.getEncoding())
font["OS/2"].usWeightClass = 400
args.output.parent.mkdir(parents=True, exist_ok=True)
font.save(args.output, reorderTables=True)
result = args.output.read_bytes()
print(json.dumps({"sourceSha256": hashlib.sha256(source).hexdigest(), "sha256": hashlib.sha256(result).hexdigest(), "size": len(result), "weight": 400, "characterCount": len(coverage), "fonttools": fontTools.__version__}))
