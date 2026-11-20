import { useEffect, useRef, useState } from "react";
import type { Match } from "./api";
import type { ModelResources } from "./battle-models";

// The match owns its bodies through the result screen. Retrying reuses successful downloads.
export function useMatchAssets(match: Match, live: boolean) {
  const owner = useRef<ModelResources | undefined>(undefined);
  const [resources, setResources] = useState<ModelResources>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const manifest = match.modelResources?.join(",") ?? "";
  useEffect(() => {
    setResources(undefined);
    return () => {
      owner.current?.dispose();
      owner.current = undefined;
    };
  }, [match.id, match.assetVersion]);
  useEffect(() => {
    if (!live) return;
    let active = true;
    setFailed(false);
    async function prepare() {
      const { ModelResources } = await import("./battle-models");
      if (!active) return;
      const assets = (owner.current ??= new ModelResources(match.assetVersion));
      await assets.prepare(manifest ? manifest.split(",") : []);
      if (active) setResources(assets);
    }
    void prepare().catch(() => {
      if (active) setFailed(true);
    });
    return () => {
      active = false;
    };
  }, [match.id, match.assetVersion, manifest, live, attempt]);
  return { resources, failed, retry: () => setAttempt((n) => n + 1) };
}
