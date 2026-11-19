import type { Catalog, Deck } from "./api";
export function DeckStrip({ deck, catalog }: { deck: Deck; catalog: Catalog }) {
  return (
    <div className="strip">
      {deck.cards.map((id, i) => {
        const card = catalog.cards.find((x) => x.id === id);
        if (!card)
          return (
            <div key={id}>
              <small>旧版卡位 {i + 1}</small>
              <b>{id}</b>
            </div>
          );
        return (
          <div key={id}>
            <img src={card.image} alt="" />
            <small>{i < 2 ? "主动 " + (i + 1) : i + 1}</small>
            <b>{card.name}</b>
            {deck.skills[id] && (
              <span>
                {card.skills.find((x) => x.id === deck.skills[id])?.name}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
