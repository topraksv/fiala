/** The KVKK notice (SPEC 5.1) on a route that opens before an account exists. Only the route: the
 *  text is `LegalNoticeBody`, shared with sign-up's sheet so the two cannot drift. */

import { useSession } from "../auth/session";
import { Screen } from "../ui/components";
import { LegalNoticeBody } from "../ui/legal-notice";

export default function PrivacyScreen() {
  const signedIn = useSession((s) => s.userId != null);
  return (
    <Screen back={signedIn ? "/settings" : "/sign-in"} width="form">
      <LegalNoticeBody />
    </Screen>
  );
}
