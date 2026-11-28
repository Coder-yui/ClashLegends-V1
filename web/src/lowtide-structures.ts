// The original atlases also encode joints, bronze trim and team-coloured lenses.
// Reuse those masks on each animated damage stage with the dock's stone and metal palette.
import {
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
} from "three";
import type { ModelProfile } from "./battle-motion";

const finish = `
  #include <map_fragment>
  vec3 paint = pow(max(diffuseColor.rgb, vec3(0.)), vec3(1./2.2));
  float value = max(max(paint.r,paint.g),paint.b);
  float luma = dot(paint,vec3(.26,.57,.17));
  float blueLens = smoothstep(.07,.22,max(paint.g,paint.b)-paint.r) *
                   smoothstep(.0,.08,paint.b-paint.g*.82);
  float redLens = smoothstep(.12,.34,paint.r-max(paint.g,paint.b));
  float enamel = max(blueLens,redLens)*smoothstep(.27,.5,value);
  // Even the darkest iron-bound sections have narrow brass seams in the atlas.
  float bronze = smoothstep(.055,.34,(paint.r-paint.b)/max(.075,luma)) *
                 smoothstep(.015,.25,(paint.g-paint.b)/max(.075,luma)) * (1.-redLens);
  float relief = smoothstep(.045,.36,luma);
  // Fine salt pitting follows the atlas through rotation, skinning and destruction.
  vec2 repeatUv = vMapUv * 350.;
  float pores = sin(repeatUv.x*2.7+sin(repeatUv.y*1.9)) * sin(repeatUv.y*.9)
                * (1.-smoothstep(.18,1.6,max(fwidth(repeatUv.x),fwidth(repeatUv.y))));
  float shade = .88 + .16*relief + .022*pores;
  vec3 stone = mix(vec3(.23,.186,.137),vec3(.66,.566,.424),relief) * shade;
  // Exposed alloy is gold on its worn arrises and brown in its cast joints.
  vec3 copper = mix(vec3(.225,.147,.079),vec3(.80,.585,.303),smoothstep(.095,.53,luma));
  float metal = bronze;
  // A deep patinated shaft, darker than the flagstones, rests on a limestone toe.
  #ifdef DOCK_SIGNAL
    float casing = smoothstep(22.,45.,dockLocal.y);
    vec3 patina = mix(vec3(.419,.383,.292),vec3(.63,.62,.48),relief);
    vec3 sandstone = mix(vec3(.47,.40,.302),vec3(.84,.729,.572),relief);
    bronze *= mix(.26,1.,smoothstep(3.,41.,dockLocal.y));
    stone = mix(sandstone,patina,casing)*shade;
    // The eight flanges of the signal housing have bronze edges and binding hoops.
    // Confine these to the stationary sleeve below the articulated turret and staff.
    float theta = atan(dockLocal.z,dockLocal.x);
    float edge = abs(sin(4.*theta+.40));
    float feather = clamp(fwidth(edge),.012,.16);
    float flanges = 1.-smoothstep(.12-feather,.12+feather,edge);
    float joint = min(abs(dockLocal.y-36.),abs(dockLocal.y-118.));
    float belt = 1.-smoothstep(1.0,1.85+fwidth(dockLocal.y)*.4,joint);
    float radius = length(dockLocal.xz);
    float sleeve = smoothstep(15.,27.,radius)*(1.-smoothstep(57.,64.,radius)) *
                   smoothstep(1.,5.,dockLocal.y)*(1.-smoothstep(124.,136.,dockLocal.y));
    // Limestone infill sits between the copper uprights on the facing sides.
    float front = smoothstep(.72,.955,abs(sin(theta)));
    float panel = smoothstep(.20,.55,edge)*smoothstep(42.,52.,dockLocal.y) *
                  (1.-smoothstep(116.,126.,dockLocal.y))*front*sleeve;
    float flecks = sin(dockLocal.y*.41+theta*16.)*sin(theta*34.-dockLocal.y*.184);
    stone = mix(stone,sandstone*shade*(.94+.052*flecks),panel*.86);
    float trim = max(flanges,belt)*sleeve;
    copper = mix(copper,vec3(.74,.543,.304)*(.81+.23*relief),trim);
    bronze = max(bronze,trim);
    metal = max(bronze,casing*.37);
  #endif
  vec3 dressed = mix(stone,copper*shade,bronze);
  #ifdef DOCK_SIGNAL
    float upright = smoothstep(12.,44.,dockLocal.y)*(1.-smoothstep(119.,156.,dockLocal.y));
    dressed += vec3(.093,.064,.042)*upright*(1.-.62*relief);
  #endif
  vec3 lens = min(paint*1.04,vec3(1.));
  diffuseColor.rgb = pow(mix(dressed,lens,enamel),vec3(2.2));
`;

function dockFinish(source: MeshBasicMaterial, crystal: boolean, root: Object3D) {
  const mat = new MeshStandardMaterial({
    name: source.name,
    map: source.map,
    side: source.side,
    alphaTest: source.alphaTest,
    transparent: source.transparent,
    opacity: source.opacity,
    // Native unlit meshes have no NORMAL stream. Derivatives follow their posed surfaces.
    flatShading: true,
    roughness: 0.86,
    metalness: 0.08,
    depthWrite: source.depthWrite,
  });
  const finishKind = crystal
    ? "crystal"
    : source.name === "RuinBase" || source.name === "Rubble"
      ? "ruin"
      : "signal";
  mat.clippingPlanes = source.clippingPlanes;
  mat.onBeforeCompile = (shader, renderer) => {
    source.onBeforeCompile(shader, renderer); // Retain the native sunken foundation clipping.
    shader.uniforms.dockObjective = { value: root.matrixWorld };
    shader.vertexShader =
      "uniform mat4 dockObjective; varying vec3 dockLocal;\n" +
      shader.vertexShader.replace(
        "#include <project_vertex>",
        "#include <project_vertex>\ndockLocal = (modelMatrix * vec4(transformed,1.)).xyz - vec3(dockObjective[3].x,0.,dockObjective[3].z);",
      );
    shader.fragmentShader =
      (finishKind === "signal" ? "#define DOCK_SIGNAL\n" : "") +
      "varying vec3 dockLocal;\n" +
      shader.fragmentShader
        .replace("#include <map_fragment>", finish)
        .replace(
          "#include <roughnessmap_fragment>",
          "#include <roughnessmap_fragment>\nroughnessFactor=mix(.89,.57,metal);",
        )
        .replace(
          "#include <metalnessmap_fragment>",
          "#include <metalnessmap_fragment>\nmetalnessFactor=mix(.02,.49,metal);",
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>\ntotalEmissiveRadiance+=pow(lens,vec3(2.2))*enamel*${crystal ? ".44" : ".30"};`,
        );
  };
  mat.customProgramCacheKey = () =>
    source.customProgramCacheKey() + "/dock-" + finishKind;
  return mat;
}

/** Dresses a cloned native objective. The caller owns the returned materials, not their shared maps. */
export function applyDockStructureMaterials(
  root: Object3D,
  profile: ModelProfile,
): Material[] {
  const crystal = profile.asset.startsWith("nexus-");
  const sunDisc = profile.asset.startsWith("sun_disc-");
  if (!crystal && !sunDisc && profile.surfaceMode !== "tower") return [];
  const copies = new Map<Material, Material>();
  function replace(source: Material): Material {
    if (!(source instanceof MeshBasicMaterial)) return source;
    if (
      sunDisc &&
      source.name !== "RuinBase" &&
      source.name !== "InnerFoundation"
    )
      return source;
    const cached = copies.get(source);
    if (cached) return cached;
    if (!source.map && source.name !== "InnerFoundation") return source;
    const next = source.map ? dockFinish(source, crystal, root) : source.clone();
    if (next instanceof MeshBasicMaterial) next.color.setHex(0x83796b);
    copies.set(source, next);
    return next;
  }
  root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    child.material = Array.isArray(child.material)
      ? child.material.map(replace)
      : replace(child.material);
    child.receiveShadow = true;
  });
  return [...copies.values()];
}
