/**
 * Finding a medicine in TİTCK's list (`docs/TASKS.md` F1.10, F1.12): the
 * search field the add screen opens with, and the rows a search or a barcode
 * that names two products shows. Each row says the list's own name split as
 * the form will take it, and the list's date is cited under the rows.
 */

import { useEffect, useState } from "react";
import { View } from "react-native";
import Pill from "lucide-react-native/icons/pill";

import { catalogueFields, formatDay } from "../domain/boxes";
import { tr } from "../i18n/tr";
import { searchCatalogue, SEARCH_FROM, type CatalogueEntry } from "../services/guide";
import { announce, Body, ListRow, Notice, TextField } from "./components";
import { motion, spacing, useTheme } from "./theme";

/** Long enough that a word typed at speed asks once. */
const PAUSE_MS = 300;

export function EntryRow({ entry, onPick }: { entry: CatalogueEntry; onPick: (entry: CatalogueEntry) => void }) {
  const { palette } = useTheme();
  const { name, strength, form, pack } = catalogueFields(entry.name);
  return (
    <ListRow
      icon={Pill}
      iconColor={entry.suspended ? palette.textSecondary : undefined}
      title={tr.common.joined(name, strength ?? undefined, form ?? undefined)}
      subtitle={tr.common.joined(pack ?? undefined, entry.activeSubstance ?? undefined, entry.holder ?? undefined, entry.suspended ? tr.catalogue.suspended : undefined)}
      chevron
      onPress={() => onPick(entry)}
    />
  );
}

/** The entries to choose from, under what asks for the choice, and the list they came from; nothing when there are none. */
export function CatalogueRows({ entries, lead, onPick }: { entries: readonly CatalogueEntry[]; lead?: string; onPick: (entry: CatalogueEntry) => void }) {
  if (entries.length === 0) return null;
  return (
    <View style={{ marginBottom: spacing.md }}>
      {lead ? <Body style={{ marginBottom: spacing.sm }}>{lead}</Body> : null}
      {entries.map((entry) => (
        <EntryRow key={entry.id} entry={entry} onPick={onPick} />
      ))}
      <Body muted>{tr.catalogue.source(formatDay(entries[0]!.listedOn))}</Body>
    </View>
  );
}

/**
 * A search of the list as it is typed: asking until the answer to what is
 * typed now arrives, which `null` says could not be had. What it says when
 * nothing is found is the screen's: the add form has its fields to fall back on.
 */
export function CatalogueSearch({
  autoFocus,
  onPick,
  none = tr.catalogue.none,
  unreachable = tr.catalogue.unreachable,
}: {
  autoFocus?: boolean;
  onPick: (entry: CatalogueEntry) => void;
  none?: string;
  unreachable?: string;
}) {
  const [query, setQuery] = useState("");
  // Kept with its question, so an earlier answer arriving late is never drawn as the latest one's.
  const [answer, setAnswer] = useState<{ query: string; found: CatalogueEntry[] | null }>({ query: "", found: [] });
  // The question still unanswered once the wait is long enough to say so (`docs/UI.md` §7.4: nothing before `motion.reveal`).
  const [slow, setSlow] = useState("");
  const asking = query.trim().length >= SEARCH_FROM;
  const found = !asking ? [] : answer.query === query ? answer.found : undefined;

  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(
      () =>
        void searchCatalogue(query).then((entries) => {
          setAnswer({ query, found: entries });
          // An error says itself (`Notice`); an answer is said here, since it only appears.
          if (entries) announce(entries.length === 0 ? none : tr.catalogue.found(entries.length));
        }),
      PAUSE_MS,
    );
    const said = setTimeout(() => setSlow(query), motion.reveal);
    return () => {
      clearTimeout(timer);
      clearTimeout(said);
    };
  }, [asking, query, none]);

  const pick = (entry: CatalogueEntry) => {
    setQuery("");
    onPick(entry);
  };

  return (
    <View style={{ marginBottom: spacing.md }}>
      <TextField label={tr.catalogue.search} value={query} onChangeText={setQuery} examples={tr.placeholders.medicine} autoFocus={autoFocus} autoCorrect={false} returnKeyType="search" maxLength={100} />
      {found === undefined && slow === query ? <Body muted style={{ marginBottom: spacing.sm }}>{tr.catalogue.searching}</Body> : null}
      {found === null ? <Notice tone="error" text={unreachable} /> : null}
      {found?.length === 0 && asking ? <Body muted style={{ marginBottom: spacing.sm }}>{none}</Body> : null}
      {found ? <CatalogueRows entries={found} onPick={pick} /> : null}
    </View>
  );
}
