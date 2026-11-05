"use client";

import { tr } from "@/lib/i18n";
import { lengthText } from "@/lib/units";
import { useState } from "react";
import { Check, ChevronRight, DoorOpen } from "lucide-react";
import type { DoorWallCollision } from "@/domain/floor-plan/door-collisions";
import type { DoorPairCollision } from "@/domain/floor-plan/door-pair-collisions";
import type { Opening, Wall } from "@/domain/floor-plan/types";
import "../door-collisions.css";

export function DoorCollisionsPanel({
  walls,
  openings,
  collisions,
  truncated,
  onLocate,
  doorPairs = [],
  pairsTruncated = false,
  onLocatePair,
  busy,
}: {
  walls: readonly Wall[];
  openings: readonly Opening[];
  collisions: readonly DoorWallCollision[];
  truncated: boolean;
  onLocate: (collision: DoorWallCollision) => void;
  doorPairs: readonly DoorPairCollision[];
  pairsTruncated: boolean;
  onLocatePair: (pair: DoorPairCollision) => void;
  busy: boolean;
}) {
  const [limit, setLimit] = useState(6);
  const [pairLimit, setPairLimit] = useState(6);
  const doorNumbers = new Map(openings.filter((opening) => opening.kind === "door").map((door, index) => [door.id, index + 1]));
  const wallNumbers = new Map(walls.map((wall, index) => [wall.id, index + 1]));
  const ordered = collisions.slice().sort((first, second) =>
    (doorNumbers.get(first.doorId) ?? 0) - (doorNumbers.get(second.doorId) ?? 0) ||
    (wallNumbers.get(first.wallId) ?? 0) - (wallNumbers.get(second.wallId) ?? 0) ||
    first.id.localeCompare(second.id));
  const pairNumbers = (pair: DoorPairCollision) =>
    pair.doorIds.map((id) => doorNumbers.get(id) ?? 0).sort((first, second) => first - second);
  const orderedPairs = doorPairs.slice().sort((first, second) => {
    const a = pairNumbers(first), b = pairNumbers(second);
    return a[0] - b[0] || a[1] - b[1] || first.id.localeCompare(second.id);
  });
  const hasCollisions = collisions.length > 0 || doorPairs.length > 0;
  return (
    <section
      className={`door-collisions-panel ${hasCollisions ? "has-collisions" : "is-clear"}`}
      aria-label={tr`Открывание дверей`}
    >
      <div className="door-collisions-heading">
        <h3>{hasCollisions ? <DoorOpen size={13} /> : <Check size={13} />}{tr` Открывание дверей`}</h3>
      </div>
      <section className="door-collision-group" aria-label={tr`Дверь и стена`} data-testid="door-wall-collision-group">
        <div className="door-collision-subheading">
          <h4>{tr`Дверь и стена`}</h4>
          <strong data-testid="door-collision-count" title={tr`Число пар дверь–стена`}>{collisions.length}</strong>
        </div>
        {collisions.length ? (
          <>
            <p>{tr`При открывании от 0° до 90° номинальное полотно пересекает стену.`}</p>
            <div className="door-collision-list">
              {ordered.slice(0, limit).map((collision) => {
                const doorNumber = doorNumbers.get(collision.doorId) ?? 0;
                const wallNumber = wallNumbers.get(collision.wallId) ?? 0;
                return (
                  <button
                    key={collision.id}
                    type="button"
                    aria-label={tr`Показать столкновение двери ${doorNumber} со стеной ${wallNumber}`}
                    title={tr`Найти место на 2D-плане`}
                    disabled={busy}
                    onClick={() => onLocate(collision)}
                  >
                    <span className="door-collision-dot" aria-hidden="true" />
                    <span>
                      <strong>{tr`Дверь `}{doorNumber}{tr` · стена `}{wallNumber}</strong>
                      <small>X: {lengthText(collision.point.x)}{" · Y: "}{lengthText(collision.point.y)}</small>
                    </span>
                    <ChevronRight size={12} />
                  </button>
                );
              })}
            </div>
            {ordered.length > limit && (
              <button
                className="text-button door-collision-show-more"
                type="button"
                disabled={busy}
                onClick={() => setLimit((previous) => previous + 6)}
              >{tr`Показать ещё (`}{ordered.length - limit})
              </button>
            )}
            {truncated && <p className="door-collision-cap">{tr`Найдено больше `}{collisions.length}{tr` столкновений. Список ограничен первыми `}{collisions.length}.</p>}
          </>
        ) : <p>{tr`Пересечений номинального полотна со стенами при открывании от 0° до 90° не найдено.`}</p>}
      </section>
      <section className="door-collision-group door-pair-collision-group" aria-label={tr`Дверь и дверь`} data-testid="door-pair-diagnostics">
        <div className="door-collision-subheading">
          <h4><span className="door-pair-collision-dot" aria-hidden="true" />{tr` Дверь и дверь`}</h4>
          <strong data-testid="door-pair-collision-count" title={tr`Число пар дверей с пересекающимися зонами открывания`}>{doorPairs.length}</strong>
        </div>
        {doorPairs.length ? (
          <>
            <p>{tr`Зоны открывания от 0° до 90° пересекаются: полотна могут мешать друг другу.`}</p>
            <div className="door-collision-list door-pair-collision-list">
              {orderedPairs.slice(0, pairLimit).map((pair) => {
                const [first, second] = pairNumbers(pair);
                return (
                  <button
                    key={pair.id}
                    type="button"
                    aria-label={tr`Показать пересечение дверей ${first} и ${second}`}
                    title={tr`Найти место на 2D-плане`}
                    disabled={busy}
                    onClick={() => onLocatePair(pair)}
                  >
                    <span className="door-pair-collision-dot" aria-hidden="true" />
                    <span>
                      <strong>{tr`Двери `}{first}{tr` и `}{second}</strong>
                      <small>X: {lengthText(pair.point.x)}{" · Y: "}{lengthText(pair.point.y)}</small>
                    </span>
                    <ChevronRight size={12} />
                  </button>
                );
              })}
            </div>
            {orderedPairs.length > pairLimit && (
              <button className="text-button door-collision-show-more door-pair-collision-show-more" type="button" disabled={busy} onClick={() => setPairLimit((previous) => previous + 6)}>{tr`Показать ещё (`}{orderedPairs.length - pairLimit})
              </button>
            )}
            {pairsTruncated && <p className="door-collision-cap">{tr`Найдено больше `}{doorPairs.length}{tr` пересекающихся пар дверей. Список ограничен первыми `}{doorPairs.length}.</p>}
          </>
        ) : <p>{tr`Пересечений зон открывания дверей не найдено.`}</p>}
      </section>
      {hasCollisions && <p>{tr`Нажмите строку, чтобы найти место на 2D-плане. Направление двери не меняется автоматически.`}</p>}
      <p className="door-collision-limits">{tr`Проверяются номинальные зоны и пересечение по высоте. Для стен учитываются их толщина и проёмы. Толщина полотна, коробка, мебель и необходимый зазор не проверяются.`}</p>
    </section>
  );
}
