"""Mixamo の FBX から、骨の姿勢を毎フレーム JSON へ書き出す。

  /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/mixamo-dump.py -- <in.fbx> <out.json>

リターゲットの計算そのものはここでは何もしない。Blender にしかできない
「FBX を読む」ところだけを担当し、あとは素の数値にして JS 側へ渡す。
こうしておくと、リターゲットの調整で Blender を起動し直さずに済む。

座標は three.js に合わせて Y-up・Z-front へ直す（Blender は Z-up・-Y front）。
向きは「回転を新しい世界座標で表しただけ」にしたいので、行列の各列
（＝ボーン局所の X/Y/Z 軸）をそれぞれ変換して入れる。Blender のボーンは
局所 +Y が骨の伸びる向きなので、変換後も y 軸が骨の向きになる。
"""
import bpy
import sys
import json
import os


def conv(v):
    """Blender (Z-up, -Y front) → three.js (Y-up, +Z front)"""
    return [v[0], v[2], -v[1]]


def norm(v):
    n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) ** 0.5
    return [v[0] / n, v[1] / n, v[2] / n] if n > 1e-9 else [0.0, 1.0, 0.0]


def basis(mat):
    """4x4 行列 → 頭の位置と、正規化した X/Y/Z 軸（three.js 座標）"""
    col = lambda i: [mat[0][i], mat[1][i], mat[2][i]]
    return {
        'head': [round(x, 6) for x in conv([mat[0][3], mat[1][3], mat[2][3]])],
        'x': [round(x, 6) for x in norm(conv(col(0)))],
        'y': [round(x, 6) for x in norm(conv(col(1)))],
        'z': [round(x, 6) for x in norm(conv(col(2)))],
    }


def strip(name):
    """mixamorig:Hips / mixamorig1:Hips → Hips"""
    return name.split(':', 1)[1] if ':' in name else name


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    if len(argv) < 2:
        raise SystemExit('usage: ... -- <in.fbx> <out.json>')
    src, dst = argv[0], argv[1]

    bpy.ops.wm.read_factory_settings(use_empty=True)
    # automatic_bone_orientation を付けると、ボーンの局所 +Y が実際の骨の向きに揃う。
    # 揃っていなくても JS 側で骨の向きは頭の位置から出し直すので、失敗しても続行する
    try:
        bpy.ops.import_scene.fbx(filepath=src, automatic_bone_orientation=True)
    except TypeError:
        bpy.ops.import_scene.fbx(filepath=src)

    arms = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    if not arms:
        raise SystemExit('armature not found in %s' % src)
    arm = arms[0]
    mw = arm.matrix_world

    order = [b.name for b in arm.pose.bones]
    parent = {strip(b.name): (strip(b.parent.name) if b.parent else None)
              for b in arm.pose.bones}
    children = {strip(b.name): [strip(c.name) for c in b.children]
                for b in arm.pose.bones}

    rest = {}
    for b in arm.data.bones:
        rest[strip(b.name)] = basis(mw @ b.matrix_local)

    scn = bpy.context.scene
    act = arm.animation_data.action if arm.animation_data else None
    if act:
        f0, f1 = (int(round(v)) for v in act.frame_range)
    else:
        f0, f1 = scn.frame_start, scn.frame_end

    frames = []
    for f in range(f0, f1 + 1):
        scn.frame_set(f)
        snap = {}
        for b in arm.pose.bones:
            snap[strip(b.name)] = basis(mw @ b.matrix)
        frames.append(snap)

    out = {
        'source': os.path.basename(src),
        'action': act.name if act else None,
        'fps': scn.render.fps / scn.render.fps_base,
        'frameStart': f0,
        'frameEnd': f1,
        'order': [strip(n) for n in order],
        'parent': parent,
        'children': children,
        'rest': rest,
        'frames': frames,
    }
    with open(dst, 'w') as fp:
        json.dump(out, fp)
    print('DUMP_OK bones=%d frames=%d fps=%.3f -> %s'
          % (len(order), len(frames), out['fps'], dst))


main()
