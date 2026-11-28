import { useEffect, useMemo, useRef, useState } from "react";
import type { Catalog, Deck, Match } from "./api";
import { terrainFor } from "./battle-map";
import { cardArt } from "./card-art";
import type { ModelResources } from "./battle-models";

function openingImages(catalog: Catalog, map: string, me: number, deck: Deck) {
  const images = new Set<string>();
  const terrain = terrainFor(catalog.maps.find((m) => m.id === map), me);
  if (terrain) images.add(terrain);
  for (const [slot, id] of deck.cards.entries()) {
    const card = catalog.cards.find((c) => c.id === id);
    if (!card) continue;
    images.add(cardArt(card, true));
    const skill = card.skills.find((s) => s.id === deck.skills[id]);
    if (slot < 2 && skill?.image) images.add(skill.image);
  }
  return [...images];
}

// The match owns its bodies through the result screen. Retrying reuses successful downloads.
export function useMatchAssets(match: Match, catalog: Catalog, live: boolean) {
  const owner = useRef<ModelResources | undefined>(undefined);
  const [resources, setResources] = useState<ModelResources>();
  const [failed, setFailed] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const manifest = match.modelResources?.join(",") ?? "";
  const images = useMemo(
    () => openingImages(catalog, match.map, match.me, match.deck),
    [catalog, match.map, match.me, match.deck],
  );
  const imageList = images.join("\n");
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
    setCompleted(0);
    async function prepare() {
      const { ModelResources } = await import("./battle-models");
      if (!active) return;
      const assets = (owner.current ??= new ModelResources(match.assetVersion));
      let models = 0,
        pictures = 0;
      function progress() {
        if (active) setCompleted(models + pictures);
      }
      await Promise.all([
        assets.prepare(manifest ? manifest.split(",") : [], (count) => {
          models = count;
          progress();
        }),
        ...imageList
          .split("\n")
          .filter(Boolean)
          .map(async (url) => {
            const image = new Image();
            image.src = url;
            await image.decode();
            pictures++;
            progress();
          }),
      ]);
      if (active) setResources(assets);
    }
    void prepare().catch(() => {
      if (active) setFailed(true);
    });
    return () => {
      active = false;
    };
  }, [match.id, match.assetVersion, manifest, imageList, live, attempt]);
  return {
    resources,
    failed,
    completed,
    total: images.length + (match.modelResources?.length ?? 0),
    retry: () => setAttempt((n) => n + 1),
  };
}
