/**
 * A document as every list draws it (`docs/TASKS.md` F3.2, F3.4): Belgeler's,
 * and a box's or a product's own, which lists the documents linked to it and
 * adds one already linked.
 */

import { View } from "react-native";
import { useRouter } from "expo-router";
import FileImage from "lucide-react-native/icons/file-image";
import FileText from "lucide-react-native/icons/file-text";
import Plus from "lucide-react-native/icons/plus";

import type { CabinetDocument } from "../data/documents";
import { DOCUMENT_KINDS } from "../db/schema";
import { useDocuments, usePeople } from "../data/hooks";
import { formatDay } from "../domain/boxes";
import { tr } from "../i18n/tr";
import { Button, Card, ChoiceTile, ListRow, rowsOf, SectionHeader } from "./components";
import { radioGroupKeys } from "./keys";
import { controlSize, spacing } from "./theme";

export const KINDS = DOCUMENT_KINDS.map((id) => ({ id, name: tr.documents.kinds[id] }));

/** Its title, or its kind where none was given. */
export const documentTitle = (document: Pick<CabinetDocument, "title" | "kind">) => document.title || tr.documents.kinds[document.kind];

export function DocumentRows({ documents, household }: { documents: readonly CabinetDocument[]; household?: { id: string; name: string } | null }) {
  const router = useRouter();
  const people = usePeople().data;
  return (
    <Card rows>
      {documents.map((document) => (
        <ListRow
          key={document.id}
          icon={document.fileType === "jpeg" ? FileImage : FileText}
          title={documentTitle(document)}
          subtitle={tr.common.joined(
            document.title ? tr.documents.kinds[document.kind] : undefined,
            document.issuedOn ? formatDay(document.issuedOn) : undefined,
            people.find((person) => person.id === document.personId)?.name,
            // Whose cabinet, once there are two to tell apart.
            household ? (document.cabinetId === household.id ? household.name : tr.households.private) : undefined,
            document.archived ? tr.documents.inArchive : undefined,
            ...document.names,
          )}
          chevron
          onPress={() => router.push({ pathname: "/document/[id]", params: { id: document.id } })}
        />
      ))}
    </Card>
  );
}

/** A box's or a product's documents, and for whoever may change it one more, linked as it is added. */
export function LinkedDocuments({ target, editable }: { target: { package: string } | { product: string }; editable: boolean }) {
  const router = useRouter();
  const linked = useDocuments().data.filter((document) => ("package" in target ? document.packageIds.includes(target.package) : document.productIds.includes(target.product)));
  if (linked.length === 0 && !editable) return null;
  return (
    <>
      <SectionHeader>{tr.documents.title}</SectionHeader>
      {linked.length > 0 ? <DocumentRows documents={linked} /> : null}
      {editable ? (
        <View style={{ alignItems: "flex-start", marginBottom: spacing.lg }}>
          <Button label={tr.documents.add} icon={Plus} variant="ghost" size="sm" onPress={() => router.push({ pathname: "/add-document", params: target })} />
        </View>
      ) : null}
    </>
  );
}

/** One choice of a few, three tiles to a row: a document's kind, or a filter. */
export function Tiles<T extends string | null>({ label, options, chosen, onChoose }: { label: string; options: readonly { id: T; name: string }[]; chosen: T; onChoose: (id: T) => void }) {
  return (
    <View role="radiogroup" {...radioGroupKeys()} accessibilityLabel={label} style={{ gap: spacing.sm, marginBottom: spacing.md }}>
      {rowsOf(options, 3).map((row, at) => (
        <View key={at} style={{ flexDirection: "row", gap: spacing.sm }}>
          {row.map((option) => (
            <ChoiceTile key={option.id ?? "all"} label={option.name} selected={chosen === option.id} minHeight={controlSize.minimumTarget} onPress={() => onChoose(option.id)} />
          ))}
        </View>
      ))}
    </View>
  );
}
