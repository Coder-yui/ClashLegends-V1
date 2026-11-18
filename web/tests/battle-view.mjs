// Start an isolated host and two browser processes. Match packets, actual
// canvas pixels and the terminal result must agree, including after a reload.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const root=fileURLToPath(new URL("../../",import.meta.url));
const host=spawn("cargo",["run","--locked","--offline","-p","clash-lobby","--example","battle_view","--","20","20261118","0"],{cwd:root,stdio:["ignore","pipe","inherit"]});
const stdout=createInterface({input:host.stdout});
const browsers=[];
try{
  const url=await Promise.race([
    once(stdout,"line").then(([line])=>new URL(line.match(/http:\/\/\S+/)[0]).href),
    once(host,"exit").then(([code])=>{throw Error("host exited "+code)})
  ]);
  const observe=async channel=>{
    const browser=await chromium.launch({channel,headless:true});browsers.push(browser);
    const page=await browser.newPage();const frames=new Map();
    page.on("websocket",ws=>ws.on("framereceived",({payload})=>{const s=JSON.parse(String(payload));frames.set(s.tick,payload)}));
    await page.goto(url);await page.waitForFunction(()=>Number(document.querySelector("canvas").dataset.tick)>0);
    return {page,frames};
  };
  const a=await observe("chrome"),b=await observe(process.env.BATTLE_SECOND_BROWSER??"msedge");
  const canvas=a.page.locator("canvas");
  const bounds=await canvas.boundingBox();
  await a.page.mouse.click(bounds.x+bounds.width*360/720,bounds.y+bounds.height*1160/1280);
  await a.page.waitForFunction(()=>document.querySelector("#inspect").textContent.includes("nexus"));
  await a.page.mouse.click(bounds.x+bounds.width/2,bounds.y+5);
  await b.page.reload();
  for(const {page} of [a,b])await page.waitForFunction(()=>Boolean(document.querySelector("canvas").dataset.result),null,{timeout:120000});
  const common=[...a.frames.keys()].filter(t=>b.frames.has(t));assert.ok(common.length>1);
  for(const t of common)assert.equal(a.frames.get(t),b.frames.get(t));
  const final=async page=>page.evaluate(()=>{const c=document.querySelector("canvas");return [c.dataset.tick,c.dataset.result,c.toDataURL()]});
  const first=await final(a.page);assert.deepEqual(first,await final(b.page));
  await a.page.reload();await a.page.waitForFunction(()=>Boolean(document.querySelector("canvas").dataset.result));
  assert.deepEqual(await final(a.page),first);
  console.log("Verified",common.length,"shared frames, terminal tick",first[0],first[1],"and reconnect");
}finally{
  for(const browser of browsers)await browser.close();
  stdout.close();host.kill();
}
