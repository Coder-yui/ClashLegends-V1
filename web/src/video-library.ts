import { currentAccount } from "./preferences";
export interface VideoClip {
  id: string;
  title: string;
  created: number;
  width: number;
  height: number;
  duration?: number;
  blob: Blob;
}
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(
      currentAccount()
        ? "clashlegends.videos.account." + currentAccount()
        : "clashlegends.videos",
      1,
    );
    req.onupgradeneeded = () =>
      req.result.createObjectStore("clips", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function saveClip(clip: VideoClip) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("clips", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.objectStore("clips").put(clip);
    });
    window.dispatchEvent(new Event("video-saved"));
  } finally {
    db.close();
  }
}
export async function readClips(): Promise<VideoClip[]> {
  const db = await database();
  try {
    return await new Promise<VideoClip[]>((resolve, reject) => {
      const req = db.transaction("clips").objectStore("clips").getAll();
      req.onsuccess = () =>
        resolve(
          (req.result as VideoClip[]).sort((a, b) => b.created - a.created),
        );
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
export function downloadClip(clip: VideoClip) {
  const url = URL.createObjectURL(clip.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download =
    "ClashLegends-" +
    clip.id +
    (clip.blob.type.includes("mp4") ? ".mp4" : ".webm");
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
