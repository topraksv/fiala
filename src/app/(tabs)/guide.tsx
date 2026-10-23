import BookOpen from "lucide-react-native/icons/book-open";

import { tr } from "../../i18n/tr";
import { EmptyState, Screen } from "../../ui/components";

/** Rehber: its entry cards arrive with their sources (`docs/TASKS.md` phase 5). */
export default function Guide() {
  return (
    <Screen title={tr.tabs.guide}>
      <EmptyState icon={BookOpen} title={tr.guide.emptyTitle} hint={tr.guide.emptyHint} />
    </Screen>
  );
}
