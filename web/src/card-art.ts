import registered from "../../content/card_art.json";
import preparation from "./preparation-data.json";

type Face = { id: string; image: string };
const art: Record<string, { image: string }> = registered;
const details: Record<string, { color: string; portrait?: string }> =
  preparation;

// Legacy atlas crops apply only where the original portrait was used.
export function cardArt(card: Face, portrait = false) {
  return (
    art[card.id]?.image ||
    (portrait && details[card.id]?.portrait) ||
    card.image
  );
}
