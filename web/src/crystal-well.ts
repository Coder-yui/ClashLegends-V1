import { Mesh, Vector3 } from "three";

// The battlefield is a baked background. Clip the model's underground fragments
// to the circular opening where their viewing rays intersect the ground.
export function applyCrystalWell(
  mesh: Mesh,
  radius: number,
  depthRatio: number,
) {
  const origin = mesh.worldToLocal(new Vector3());
  const radial = mesh.worldToLocal(new Vector3(radius, 0, 0)).sub(origin);
  const materials = [mesh.material].flat().map((source) => {
    const material = source.clone();
    material.customProgramCacheKey = () => "crystal-well";
    material.onBeforeCompile = (shader) => {
      shader.uniforms.wellOrigin = { value: origin };
      shader.uniforms.wellRadial = { value: radial };
      shader.uniforms.wellDepth = { value: depthRatio };
      const varyings = "varying vec3 wellPosition;\nvarying vec3 wellRay;\n";
      shader.vertexShader =
        varyings +
        "uniform vec3 wellOrigin;\nuniform vec3 wellRadial;\n" +
        shader.vertexShader.replace(
          "#include <project_vertex>",
          `
          #include <project_vertex>
          vec3 surfaceWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vec3 center = (modelMatrix * vec4(wellOrigin, 1.0)).xyz;
          wellPosition = (surfaceWorld - center) / length(mat3(modelMatrix) * wellRadial);
          wellRay = isOrthographic
            ? vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2])
            : cameraPosition - surfaceWorld;
        `,
        );
      shader.fragmentShader =
        varyings +
        "uniform float wellDepth;\n" +
        shader.fragmentShader.replace(
          "#include <clipping_planes_fragment>",
          `
          #include <clipping_planes_fragment>
          if (wellPosition.y < 0.0) {
            if (wellRay.y <= 0.0001 || wellPosition.y < -wellDepth) discard;
            vec2 opening = wellPosition.xz - wellRay.xz * (wellPosition.y / wellRay.y);
            if (dot(opening, opening) > 1.0) discard;
          }
        `,
        );
    };
    return material;
  });
  mesh.material = Array.isArray(mesh.material) ? materials : materials[0];
}
