/** Reporting a problem (SPEC 4.1). Categories are tiles, since each carries the sentence that makes
 *  reporter and owner mean one thing. Signed out, it asks an address and takes no screenshots. */

import { useState } from "react";
import { Image, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import ImagePlus from "lucide-react-native/icons/image-plus";
import Send from "lucide-react-native/icons/send";
import X from "lucide-react-native/icons/x";

import { useSession } from "../auth/session";
import { isEmail } from "../domain/names";
import { FEEDBACK_CATEGORIES, FEEDBACK_MESSAGE_MAX, FEEDBACK_MESSAGE_MIN, MAX_FEEDBACK_IMAGES, feedbackMessageRejection, type FeedbackCategory } from "../domain/feedback";
import { tr } from "../i18n/tr";
import { sendFeedback, type FeedbackResult } from "../services/feedback";
import { Body, Button, ChoiceTile, FieldError, IconButton, Notice, Screen, SectionHeader, TextField, rowsOf } from "../ui/components";
import { useDirtyExitGuard } from "../ui/dirty-exit";
import { radioGroupKeys } from "../ui/keys";
import { navigateBack } from "../ui/navigation";
import { controlSize, radius, screenshot, spacing, useTheme } from "../ui/theme";
import { showNotice } from "../ui/undo";

const loadTake = () => import("../ui/photo-take").then((module) => module.default);

const REFUSED: Record<Exclude<FeedbackResult, "sent">, string> = {
  unconfigured: tr.feedback.unconfigured,
  unauthenticated: tr.feedback.unauthenticated,
  rateLimited: tr.feedback.rateLimited,
  failed: tr.feedback.failed,
};

export default function FeedbackScreen() {
  const router = useRouter();
  const signedIn = useSession((s) => s.userId != null);
  const home = signedIn ? "/settings" : "/sign-in";
  const [replyTo, setReplyTo] = useState(useLocalSearchParams<{ email?: string }>().email ?? "");
  const [category, setCategory] = useState<FeedbackCategory>("functional");
  const [message, setMessage] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Said only once a send is tried, so the form does not scold while typing.
  const [attempted, setAttempted] = useState(false);
  const rejection = feedbackMessageRejection(message);
  const full = images.length >= MAX_FEEDBACK_IMAGES;
  const { allowExit } = useDirtyExitGuard(message.trim() !== "" || images.length > 0 || category !== "functional");

  const pick = async () => {
    setRefusal(null);
    try {
      const taken = await (await loadTake())("library", screenshot.edge);
      if (typeof taken !== "string") setImages((current) => [...current, taken.data]);
    } catch {
      setRefusal(tr.feedback.unreadable);
    }
  };

  const submit = async () => {
    setAttempted(true);
    if (rejection || (!signedIn && !isEmail(replyTo))) return;
    setBusy(true);
    setRefusal(null);
    const result = await sendFeedback(signedIn ? { category, message, images } : { category, message, images: [], replyTo });
    setBusy(false);
    if (result !== "sent") return setRefusal(REFUSED[result]);
    showNotice(tr.feedback.sent);
    allowExit(() => navigateBack(router, home));
  };

  return (
    <Screen back={home} title={tr.feedback.title} width="form">
      <Body muted style={{ marginBottom: spacing.lg }}>{tr.feedback.intro}</Body>
      <SectionHeader>{tr.feedback.categoryLabel}</SectionHeader>
      <View role="radiogroup" {...radioGroupKeys()} accessibilityLabel={tr.feedback.categoryLabel} style={{ gap: spacing.sm }}>
        {rowsOf(FEEDBACK_CATEGORIES, 2).map((row, at) => (
          <View key={at} style={{ flexDirection: "row", gap: spacing.sm }}>
            {row.map((value) => (
              <ChoiceTile
                key={value}
                label={tr.feedback.category[value]}
                description={tr.feedback.categoryHint[value]}
                selected={category === value}
                minHeight={controlSize.minimumTarget}
                onPress={() => setCategory(value)}
              />
            ))}
          </View>
        ))}
      </View>
      <SectionHeader>{tr.feedback.messageLabel}</SectionHeader>
      <TextField
        value={message}
        onChangeText={setMessage}
        multiline
        maxLength={FEEDBACK_MESSAGE_MAX}
        accessibilityLabel={tr.feedback.messageLabel}
        examples={tr.placeholders.feedback}
      />
      {attempted && rejection ? <FieldError text={tr.feedback.rejected[rejection](FEEDBACK_MESSAGE_MIN, message.trim().length)} /> : null}
      {signedIn ? (
        <>
          <SectionHeader>{tr.feedback.imageTitle}</SectionHeader>
          <Body muted>{tr.feedback.imageHint(MAX_FEEDBACK_IMAGES)}</Body>
          <Shots images={images} onRemove={(at) => setImages((current) => current.filter((_, position) => position !== at))} />
          <Button label={tr.feedback.imageAdd} icon={ImagePlus} variant="ghost" disabled={busy || full} onPress={() => void pick()} />
        </>
      ) : (
        <>
          <SectionHeader>{tr.feedback.replyToLabel}</SectionHeader>
          <TextField
            value={replyTo}
            onChangeText={setReplyTo}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            accessibilityLabel={tr.feedback.replyToLabel}
            placeholder={tr.placeholders.email}
          />
          {attempted && !isEmail(replyTo) ? <FieldError text={tr.auth.emailInvalid} /> : null}
        </>
      )}
      {refusal ? <Notice tone="error" text={refusal} /> : null}
      <Body muted style={{ marginTop: spacing.lg }}>{signedIn ? tr.feedback.privacy : tr.feedback.privacySignedOut}</Body>
      <View style={{ alignItems: "flex-start", marginBottom: spacing.lg }}>
        <Button label={tr.legal.open} variant="ghost" size="sm" onPress={() => router.push("/privacy")} />
      </View>
      <Button label={busy ? tr.feedback.sending : tr.feedback.send} icon={Send} disabled={busy} onPress={() => void submit()} />
    </Screen>
  );
}

function Shots({ images, onRemove }: { images: readonly string[]; onRemove: (at: number) => void }) {
  const { palette } = useTheme();
  if (images.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginVertical: spacing.md }}>
      {images.map((uri, at) => (
        <View key={at} style={{ alignItems: "center" }}>
          <Image
            source={{ uri }}
            accessibilityLabel={tr.feedback.imageLabel(at + 1)}
            style={{ width: screenshot.thumb, height: screenshot.thumb, borderRadius: radius.sm, backgroundColor: palette.surfaceAlt }}
          />
          <IconButton icon={X} tone="danger" label={tr.feedback.imageRemove(at + 1)} onPress={() => onRemove(at)} />
        </View>
      ))}
    </View>
  );
}
