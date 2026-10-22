import Sparkles from "lucide-react-native/icons/sparkles";

import { tr } from "../../i18n/tr";
import { EmptyState, Screen } from "../../ui/components";

/** The home tab, until the first feature replaces it. */
export default function Home() {
  return (
    <Screen title={tr.tabs.home}>
      <EmptyState icon={Sparkles} title={tr.home.emptyTitle} hint={tr.home.emptyHint} />
    </Screen>
  );
}
