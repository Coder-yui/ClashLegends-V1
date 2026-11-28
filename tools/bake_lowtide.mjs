// Bake seat-specific terrain fallbacks and the catalog portrait with the live game's meshes and light.
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(path.join(root, "web/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const dest = path.join(root, "web/public/media/battle/lowtide-dock");
const qa = path.join(root, ".local/qa/lowtide-dock");
await mkdir(qa, { recursive: true });
const entry = `
import * as T from "three";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { LowtideTerrain } from "./lowtide-terrain";
import { loadModel, modelSurfaces, enableStructureShadows } from "./battle-models";
import { profileFor } from "./battle-motion";
import { applyDockStructureMaterials } from "./lowtide-structures";
import plan from "../../content/lowtide-layout.json";
const canvas=document.createElement("canvas");
const renderer=new T.WebGLRenderer({canvas, antialias:true, alpha:false,preserveDrawingBuffer:true});
renderer.localClippingEnabled=true;
renderer.setClearColor(0x6c8180,1);
const scene=new T.Scene(), dock=new LowtideTerrain(renderer), buildings=new T.Group();
scene.add(dock.root,buildings);
const frame={map:plan,units:[],ruinedTowers:[]};
async function populate(){
  for(const [team,key] of ["blue","red"].entries()) {
    for(const [kind,places] of [["princess_tower",plan.teams[key].towers],["nexus",[plan.teams[key].nexus]]]){
      const profile=profileFor({kind,team}), asset=await loadModel(profile);
      for(const [x,z] of places){
        frame.units.push({kind,team,x,y:z});
        const body=clone(asset.scene);
        applyDockStructureMaterials(body,profile);
        const mix=new T.AnimationMixer(body);mix.clipAction(asset.animations.find(a=>a.name===profile.idle)).play();mix.update(.4);
        modelSurfaces(body,profile)?.(profile.idle,.4);
        body.position.set(x-plan.width/2,profile.groundOffset,z-plan.height/2);
        body.scale.setScalar(profile.scale);body.rotation.y=(team?0:Math.PI)+(profile.yaw??0);
        enableStructureShadows(body);
        buildings.add(body);
      }
    }
  }
}
const usable=Promise.all([dock.ready,populate()]);
window.bake=async function(kind){
  await usable;
  const reversed=kind==="red";const actors=kind!=="blue" && kind!=="red";
  dock.root.rotation.y=reversed?Math.PI:0;
  buildings.visible=actors;
  dock.update(actors?frame:{...frame,units:[]},Number(reversed));
  const depth=(plan.height+2*90)*Math.cos(Math.PI/5);
  const wide=kind==="blue"||kind==="red";
  let camera,width,height;
  if(kind==="timber" || kind==="close"){
    width=1400; height=860;
    camera=new T.PerspectiveCamera(38,width/height,1,12000);
    if(kind==="timber"){camera.position.set(510,190,190);camera.lookAt(390,-4,0);}
    else {camera.position.set(486,196,-22);camera.lookAt(180,6,-269);}
  }else if(kind==="sample" || kind==="detail"){
    width=1400;height=860;
    const span=kind==="sample"?870:1500;
    camera=new T.OrthographicCamera(-span/2,span/2,span*height/width/2,-span*height/width/2,1,12000);
    if(kind==="sample"){camera.position.set(40,1040,1030);camera.lookAt(-310,0,219);}
    else{camera.position.set(1270,980,570);camera.lookAt(-60,0,-95);}
  }else{
    const span=wide?3680:1330;
    width=wide?2944:1180;height=Math.round(width*depth/span);
    camera=new T.OrthographicCamera(-span/2,span/2,depth/2,-depth/2,1,15000);
    camera.position.set(0,Math.cos(Math.PI/5)*3600,Math.sin(Math.PI/5)*3600);camera.lookAt(0,0,0);
  }
  camera.updateMatrixWorld();renderer.setSize(width,height,false);
  renderer.shadowMap.needsUpdate=true;
  renderer.render(scene,camera);
  return canvas.toDataURL("image/webp",wide?.89:.94).split(",")[1];
};
`;
const bundle = await build({
  stdin: {
    contents: entry,
    resolveDir: path.join(root, "web/src"),
    loader: "ts",
  },
  write: false,
  bundle: true,
  format: "iife",
  platform: "browser",
  logLevel: "silent",
  define: { "process.env.NODE_ENV": '"production"' },
});
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (type, data) => {
    res.setHeader("Content-Type", type);
    res.end(data);
  };
  if (url.pathname === "/")
    return send(
      "text/html",
      '<!doctype html><meta charset="utf-8"><script src="/bundle.js"></script>',
    );
  if (url.pathname === "/bundle.js")
    return send(
      "application/javascript",
      Buffer.from(bundle.outputFiles[0].contents),
    );
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }
  if (url.pathname.startsWith("/play/media/")) {
    try {
      return send(
        "application/octet-stream",
        await readFile(
          path.join(
            root,
            "web/public",
            decodeURIComponent(url.pathname.slice(6)),
          ),
        ),
      );
    } catch {}
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  channel: "chrome",
  args: ["--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => {
    errors.push(String(e));
    console.error(e);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(msg.text());
      console.error(msg.text());
    }
  });
  await page.goto("http://127.0.0.1:" + server.address().port + "/", {
    timeout: 90000,
    waitUntil: "domcontentloaded",
  });
  for (const [name, file] of Object.entries({
    blue: path.join(dest, "overview.webp"),
    red: path.join(dest, "overview-red.webp"),
    portrait: path.join(dest, "preview.webp"),
    detail: path.join(qa, "harbor-detail.webp"),
    close: path.join(qa, "boat-repair.webp"),
    timber: path.join(qa, "timber-bridge.webp"),
    sample: path.join(qa, "west-tower-and-bridge.webp"),
  })) {
    const bytes = await page.evaluate(
      async (name) => await window.bake(name),
      name,
    );
    if (errors.length) throw new Error(errors.join("\n"));
    await writeFile(file, Buffer.from(bytes, "base64"));
    console.log(file);
  }
} finally {
  await browser.close();
  server.close();
}
