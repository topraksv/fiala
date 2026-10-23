/**
 * Which of Durum's cards show, and in what order (`docs/TASKS.md` F1.26):
 * each moves a place at a time and hides with its own switch, saved as it
 * changes. Pushed from Durum's header.
 */

import { useEffect, useState } from "react";
import { View } from "react-native";
import ArrowDown from "lucide-react-native/icons/arrow-down";
import ArrowUp from "lucide-react-native/icons/arrow-up";

import { tr } from "../i18n/tr";
import { Body, Card, IconButton, ListRow, Screen, Toggle } from "../ui/components";
import { appError } from "../ui/dialog";
import { layoutFrom, moveCard, readCardLayout, saveCardLayout, type CardLayout, type StatusCard } from "../ui/status-cards";
import { spacing } from "../ui/theme";

/** Each card by the title it has on Durum. */
const NAMES: Record<StatusCard, string> = {
  doses: tr.doses.todaySection,
  lists: tr.status.listsSection,
  expired: tr.status.expiredSection,
  soon: tr.status.soonSection,
  opened: tr.status.openedSection,
  stock: tr.status.stockSection,
  undated: tr.status.undatedSection,
  boxes: tr.status.boxesSection,
  people: tr.status.peopleSection,
  recent: tr.status.recentSection,
};

export default function StatusCards() {
  const [layout, setLayout] = useState<CardLayout | null>(null);
  useEffect(() => void readCardLayout().then(setLayout, () => setLayout(layoutFrom(null))), []);
  if (!layout) return <Screen back="/" title={tr.statusCards.title} />;

  const change = (next: CardLayout) => {
    setLayout(next);
    saveCardLayout(next).catch(() => appError(tr.errors.saveFailed));
  };
  const shown = (card: StatusCard) => !layout.hidden.includes(card);
  return (
    <Screen back="/" title={tr.statusCards.title}>
      <Body muted style={{ marginBottom: spacing.md }}>{tr.statusCards.hint}</Body>
      <Card rows>
        {layout.order.map((card, at) => (
          <ListRow
            key={card}
            title={NAMES[card]}
            right={
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                <IconButton icon={ArrowUp} label={tr.statusCards.up(NAMES[card])} disabled={at === 0} onPress={() => change({ ...layout, order: moveCard(layout.order, card, -1) })} />
                <IconButton icon={ArrowDown} label={tr.statusCards.down(NAMES[card])} disabled={at === layout.order.length - 1} onPress={() => change({ ...layout, order: moveCard(layout.order, card, 1) })} />
                <Toggle
                  label={tr.statusCards.show(NAMES[card])}
                  value={shown(card)}
                  onValueChange={(show) => change({ ...layout, hidden: show ? layout.hidden.filter((each) => each !== card) : [...layout.hidden, card] })}
                />
              </View>
            }
          />
        ))}
      </Card>
    </Screen>
  );
}
