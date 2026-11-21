import { Color, PerspectiveCamera, Scene } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Frame } from "./battle-field";

export class ReplayCamera {
  readonly camera = new PerspectiveCamera(40, 1, 1, 16000);
  private orbit: OrbitControls;
  constructor(
    private scene: Scene,
    canvas: HTMLCanvasElement,
    map: Frame["map"],
  ) {
    scene.background = new Color(0x253943);
    this.camera.position.set(0, map.height * 0.92, map.height * 0.76);
    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.minDistance = 32;
    this.orbit.maxDistance = map.height * 3;
    this.orbit.maxPolarAngle = Math.PI * 0.485;
    this.orbit.screenSpacePanning = false;
    this.orbit.update();
  }
  resize(w: number, h: number) {
    if (this.camera.aspect === w / h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  dispose() {
    this.orbit.dispose();
    this.scene.background = null;
  }
}
