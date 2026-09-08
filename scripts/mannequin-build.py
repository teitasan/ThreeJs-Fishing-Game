"""Mixamo の Mannequin と釣りモーションをひとつの GLB にまとめる。

  Blender -b -P scripts/mannequin-build.py -- <out.glb> <char.fbx> <name=anim.fbx> ...

キャラもモーションも mixamorig なので、モーション側のアクションをそのまま
キャラの骨格へ移せる（リターゲットは要らない）。glTF は NLA トラック 1 本を
1 クリップとして書き出すので、名前を付けたトラックへ積んでいく。

つまづく点がふたつある。
 * 接頭辞が食い違う。キャラの FBX は mixamorig1: で、モーションの FBX は
   mixamorig:。骨の名前が合わないとアクションが乗らないので、先に揃える。
 * Mannequin は 4096x4096 のテクスチャを 4 枚持っている。見た目はほぼ無地の
   マネキンで、このゲームはフラットな低ポリなので、素の色に置き換えて捨てる。
"""
import bpy
import sys
import os
import re


def norm_bone_prefix(arm, want='mixamorig:'):
    """mixamorig1: などの接頭辞を want へ揃える（頂点グループも一緒に）"""
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    for b in arm.data.bones:
        m = re.match(r'^(mixamorig\d*:)(.*)$', b.name)
        if not m or m.group(1) == want:
            continue
        old = b.name
        b.name = want + m.group(2)
        for ob in meshes:
            g = ob.vertex_groups.get(old)
            if g:
                g.name = b.name


def action_fcurves(act):
    """Blender 4.4 以降はアクションが層とスロットに分かれ、fcurves が直下に無い"""
    fcs = getattr(act, 'fcurves', None)
    if fcs is not None:
        return list(fcs)
    out = []
    for layer in getattr(act, 'layers', []):
        for strip in getattr(layer, 'strips', []):
            for cb in getattr(strip, 'channelbags', []):
                out.extend(cb.fcurves)
    return out


def flatten_materials(color=(0.82, 0.66, 0.52, 1.0)):
    """テクスチャを捨てて素の色にする。4K を 4 枚積むと GLB が数十 MB になる"""
    mat = bpy.data.materials.new('Mannequin')
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    if bsdf:
        bsdf.inputs['Base Color'].default_value = color
        bsdf.inputs['Roughness'].default_value = 0.62
        if 'Metallic' in bsdf.inputs:
            bsdf.inputs['Metallic'].default_value = 0.0
    for ob in bpy.data.objects:
        if ob.type != 'MESH':
            continue
        ob.data.materials.clear()
        ob.data.materials.append(mat)
    for img in list(bpy.data.images):
        bpy.data.images.remove(img)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    out, char = argv[0], argv[1]
    anims = []
    for a in argv[2:]:
        name, _, path = a.partition('=')
        anims.append((name, path))

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=char, automatic_bone_orientation=True)
    arms = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    if len(arms) != 1:
        raise SystemExit('armature が %d 個。1 個のはず' % len(arms))
    arm = arms[0]
    norm_bone_prefix(arm)
    bones = [b.name for b in arm.data.bones]
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    verts = sum(len(m.data.vertices) for m in meshes)
    tris = sum(len(m.data.loop_triangles) for m in meshes)
    if not tris:
        for m in meshes:
            m.data.calc_loop_triangles()
        tris = sum(len(m.data.loop_triangles) for m in meshes)
    zs = [(arm.matrix_world @ b.head_local).z for b in arm.data.bones]
    print('CHAR bones=%d meshes=%d verts=%d tris=%d 高さ=%.3f' % (
        len(bones), len(meshes), verts, tris, max(zs) - min(zs)))
    print('CHAR prefix=%s' % bones[0])
    print('CHAR images=%s' % [(i.name, tuple(i.size)) for i in bpy.data.images])

    if arm.animation_data is None:
        arm.animation_data_create()
    for name, path in anims:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=True)
        added = [o for o in bpy.data.objects if o not in before]
        src = next((o for o in added if o.type == 'ARMATURE'), None)
        if src is None or src.animation_data is None or src.animation_data.action is None:
            raise SystemExit('%s にアクションが無い' % path)
        act = src.animation_data.action
        act.name = name
        act.use_fake_user = True
        # 骨の名前が食い違うとアクションが乗らないので確かめる
        missing = set()
        for fc in action_fcurves(act):
            if 'pose.bones["' in fc.data_path:
                bn = fc.data_path.split('"')[1]
                if bn not in arm.data.bones:
                    missing.add(bn)
        src.animation_data.action = None
        for o in added:
            bpy.data.objects.remove(o, do_unlink=True)
        if missing:
            raise SystemExit('%s: キャラに無い骨 %s' % (path, sorted(missing)[:5]))
        track = arm.animation_data.nla_tracks.new()
        track.name = name
        f0 = int(round(act.frame_range[0]))
        track.strips.new(name, f0, act)
        print('ANIM %-12s frames=%d..%d' % (name, f0, int(round(act.frame_range[1]))))

    flatten_materials()
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format='GLB',
        export_animations=True,
        export_animation_mode='NLA_TRACKS',
        export_yup=True,
        export_apply=False,
    )
    print('BUILD_OK %s (%.1f MB)' % (out, os.path.getsize(out) / 1e6))


main()
