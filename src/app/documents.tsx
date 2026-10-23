/**
 * Belgeler (`docs/TASKS.md` F3.2, F3.3): the documents of the person's own
 * cabinet and of the household open, as Dolabım lists boxes; found by their
 * title, note, number, person or the medicines they are linked to, and by
 * kind. The archived ones are a kind of their own here, out of the way.
 */

import { useState } from "react";
import { useRouter } from "expo-router";
import FileText from "lucide-react-native/icons/file-text";
import Plus from "lucide-react-native/icons/plus";

import type { CabinetDocument } from "../data/documents";
import { useDocuments, useHouseholds, usePeople } from "../data/hooks";
import { DOCUMENT_KINDS } from "../db/schema";
import { matchesSearch } from "../domain/boxes";
import { tr } from "../i18n/tr";
import { Body, Button, EmptyState, IconButton, ReadFailed, Screen, TextField } from "../ui/components";
import { DocumentRows, KINDS, Tiles } from "../ui/documents";
import { spacing } from "../ui/theme";

const ARCHIVED = "archived" as const;
type Kind = (typeof DOCUMENT_KINDS)[number] | typeof ARCHIVED | null;

export default function Documents() {
  const router = useRouter();
  const documents = useDocuments();
  const { open, shows } = useHouseholds();
  const people = usePeople().data;
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>(null);
  const [whose, setWhose] = useState<string | null>(null);
  const shown = documents.data.filter((document) => shows(document.cabinetId));
  // Only the people a document names: a filter that finds nothing is not offered.
  const named = people.filter((person) => shown.some((document) => document.personId === person.id));
  const person = named.some((each) => each.id === whose) ? whose : null;
  const nameOf = (document: CabinetDocument) => people.find((each) => each.id === document.personId)?.name;
  const found = shown.filter(
    (document) =>
      (kind === ARCHIVED ? document.archived : !document.archived && (kind == null || document.kind === kind)) &&
      (person == null || document.personId === person) &&
      matchesSearch([document.title, tr.documents.kinds[document.kind], document.note, document.reference, nameOf(document), ...document.names], query),
  );
  const add = () => router.push("/add-document");
  const kinds: { id: Kind; name: string }[] = [
    { id: null, name: tr.documents.allKinds },
    ...KINDS,
    ...(shown.some((document) => document.archived) ? [{ id: ARCHIVED, name: tr.documents.archivedTile }] : []),
  ];

  if (documents.status === "error") {
    return (
      <Screen back="/cabinet" title={tr.documents.title}>
        <ReadFailed queries={[documents]} />
      </Screen>
    );
  }
  return (
    <Screen back="/cabinet" title={tr.documents.title} actions={shown.length > 0 ? <IconButton icon={Plus} label={tr.documents.add} onPress={add} /> : null}>
      {documents.status === "loading" ? null : shown.length === 0 ? (
        <EmptyState icon={FileText} title={tr.documents.emptyTitle} hint={tr.documents.emptyHint} action={<Button label={tr.documents.add} icon={Plus} onPress={add} />} />
      ) : (
        <>
          <TextField
            accessibilityLabel={tr.documents.search}
            value={query}
            onChangeText={setQuery}
            examples={tr.documents.searchExamples}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={80}
            style={{ marginBottom: spacing.sm }}
          />
          <Tiles label={tr.documents.kindSection} options={kinds} chosen={kind} onChoose={setKind} />
          {named.length > 0 ? <Tiles label={tr.documents.whoseSection} options={[{ id: null, name: tr.cabinet.everyone.people }, ...named]} chosen={person} onChoose={setWhose} /> : null}
          {found.length === 0 ? <Body muted>{tr.documents.noFiltered}</Body> : <DocumentRows documents={found} household={open} />}
        </>
      )}
    </Screen>
  );
}
