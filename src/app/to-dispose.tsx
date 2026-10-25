/**
 * The boxes to get rid of (`docs/TASKS.md` F1.23): expired and still at home.
 * Leaving marks a box disposed rather than deleting it, so its record and
 * history stay; the undo bar takes it back. How to get rid of one is the
 * Sıfır Atık guide's, in three lines and a link to it (F7.9).
 */

import ExternalLink from "lucide-react-native/icons/external-link";
import PackageCheck from "lucide-react-native/icons/package-check";
import PackageX from "lucide-react-native/icons/package-x";

import { editBoxes, type CabinetBox, type CabinetProduct } from "../data/cabinet";
import { useHouseholds, useShownCabinet } from "../data/hooks";
import { SOON_DAYS, expiryState, formatDay, isEmpty, localDay } from "../domain/boxes";
import { undoRows } from "../db/mutations";
import { tr } from "../i18n/tr";
import { Body, Button, Card, EmptyState, IconButton, ListRow, ReadFailed, Screen, SectionHeader } from "../ui/components";
import { appError } from "../ui/dialog";
import { openLink } from "../ui/guide";
import { spacing, useTheme } from "../ui/theme";
import { showUndo } from "../ui/undo";

type Held = { product: CabinetProduct; box: CabinetBox };

/** The ministry's own page on medicine waste: where it goes, and why not the sink. */
const WASTE_GUIDE = "https://sifiratik.gov.tr/sifir-atik/atik-ayirma-kilavuzu/ilac";

function HowToDispose() {
  return (
    <>
      <SectionHeader>{tr.toDispose.howTitle}</SectionHeader>
      <Card rows>
        {tr.toDispose.how.map((line) => (
          <ListRow key={line} title={line} />
        ))}
        <ListRow icon={ExternalLink} title={tr.toDispose.guide} subtitle={tr.toDispose.guideSource} onPress={() => void openLink(WASTE_GUIDE)} />
      </Card>
    </>
  );
}

export default function ToDispose() {
  const { palette } = useTheme();
  const cabinet = useShownCabinet();
  const today = localDay();
  // As Durum counts them: an empty box asks for nothing.
  const expired: Held[] = cabinet.data.flatMap((product) =>
    product.boxes
      .filter((box) => box.disposition == null && !isEmpty(box) && expiryState(box.expiresOn, today, box.soonDays ?? SOON_DAYS) === "expired")
      .map((box) => ({ product, box })),
  );
  const nameOf = ({ product, box }: Held) => tr.common.boxName(product, box);
  const { writes } = useHouseholds();
  // A household the person only reads keeps its boxes on the list, for whoever may mark them.
  const theirs = expired.filter(({ box }) => writes(box.cabinetId));

  const dispose = async (held: readonly Held[]) => {
    try {
      const written = await editBoxes(held.map(({ box }) => box.id), { disposition: "disposed" });
      if (written) showUndo(tr.toDispose.doneNotice(held.length), () => undoRows(written));
    } catch {
      await appError(tr.errors.saveFailed);
    }
  };

  if (cabinet.status === "error") {
    return (
      <Screen back="/" title={tr.toDispose.title}>
        <ReadFailed queries={[cabinet]} />
      </Screen>
    );
  }
  return (
    <Screen back="/" title={tr.toDispose.title}>
      {cabinet.status === "loading" ? null : expired.length === 0 ? (
        <EmptyState icon={PackageCheck} title={tr.toDispose.emptyTitle} hint={tr.toDispose.emptyHint} />
      ) : (
        <>
          <Body muted style={{ marginBottom: spacing.md }}>{tr.toDispose.hint}</Body>
          <Card rows>
            {expired.map((held) => (
              <ListRow
                key={held.box.id}
                icon={PackageX}
                iconColor={palette.error}
                title={nameOf(held)}
                subtitle={tr.cabinet.expires(formatDay(held.box.expiresOn!))}
                right={theirs.includes(held) ? <IconButton icon={PackageCheck} label={tr.toDispose.done(nameOf(held))} onPress={() => void dispose([held])} /> : undefined}
              />
            ))}
          </Card>
          {theirs.length > 0 ? <Button label={tr.toDispose.all} variant="secondary" onPress={() => void dispose(theirs)} /> : null}
        </>
      )}
      {cabinet.status === "loading" ? null : <HowToDispose />}
    </Screen>
  );
}
