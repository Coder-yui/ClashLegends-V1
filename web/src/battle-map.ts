import { fieldMargin } from "./battle-geometry";
import type { CSSProperties } from "react";
import type { CatalogMap } from "./api";
import type { Frame } from "./battle-field";

type Region = Frame["deployment"][number][number];
type Zone = "Empty" | "Field" | { Home: number[] };
type CompactPacket = Omit<Frame, "map" | "deployment"> & {
  map: Omit<Frame["map"], "obstacles">;
  deploymentZones: Zone[];
};

const regionCache = new WeakMap<CatalogMap, Map<string, Region[]>>();

function regionsFor(map: CatalogMap, me: number, zone: Zone) {
  let cache = regionCache.get(map);
  if (!cache) regionCache.set(map, (cache = new Map()));
  const key = me + "/" + JSON.stringify(zone);
  const saved = cache.get(key);
  if (saved) return saved;
  let rectangles: number[][];
  if (zone === "Empty") rectangles = [];
  else if (zone === "Field") {
    const [x, y] = map.tileOrigin ?? [0, 0];
    rectangles = [
      [
        0,
        0,
        Math.floor((map.width - 2 * x) / map.tile),
        Math.floor((map.height - 2 * y) / map.tile),
      ],
    ];
  } else {
    const home = me ? map.redHome : map.home;
    const pockets = me ? map.redPockets : map.pockets;
    if (!home || !pockets) throw new Error("未载入本方地图部署区");
    rectangles = [...home, ...zone.Home.flatMap((i) => pockets[i])];
  }
  const result = rectangles.map(([x, y, width, height]) => ({
    x,
    y,
    width,
    height,
  }));
  cache.set(key, result);
  return result;
}

// The catalog contains static dock geometry. Live, reconnect and replay packets
// only need the current open pockets for each card.
export function readBattleFrame(
  packet: Frame | CompactPacket,
  map: CatalogMap | undefined,
  me: number,
): Frame {
  if (!("deploymentZones" in packet)) return packet;
  if (!map || map.id !== packet.map.id) throw new Error("未载入对局地图");
  return {
    ...packet,
    map: {
      ...packet.map,
      tileOrigin: map.tileOrigin,
      obstacles: map.obstacles,
      landObstacles: map.landObstacles,
    },
    deployment: packet.deploymentZones.map((zone) => regionsFor(map, me, zone)),
  };
}

export function terrainFor(
  map: { terrain?: string | null; terrainRed?: string | null } | undefined,
  me: number,
) {
  return (me && map?.terrainRed) || map?.terrain;
}

export function battleStageStyle(
  map: Frame["map"] | undefined,
): CSSProperties | undefined {
  if (!map) return;
  return {
    "--map-width": map.width,
    "--map-height": map.height,
    "--ground-depth": map.height + 2 * map.backMargin,
    "--projection": map.projection,
    "--backdrop-width": map.backdropWidth,
    "--terrain": map.terrain ? 'url("' + map.terrain + '")' : "none",
    ...(map.id === "lowtide-dock" && {
      "--ground-y":
        "min(calc((100dvh - var(--tray-height)) / var(--ground-depth)), calc(100vw * var(--projection) / var(--map-width)))",
      "--battle-underlay": "#233136",
      "--terrain-clip": `inset(calc(${Math.max(0, fieldMargin - map.backMargin)} * var(--ground-y)) 0)`,
    }),
  } as CSSProperties;
}
